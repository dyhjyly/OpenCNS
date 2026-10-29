import { log } from '../logger.js';
import { chatText, type ChatMessage } from '../llm/client.js';
import { buildIdentityPrompt } from '../chat/prompt.js';
import { getActorNames } from '../chat/store.js';
import { loadContextHistory } from '../chat/context.js';
import { appendMessage } from '../chat/store.js';
import { postFromWake } from '../social/moments.js';
import { renderNowBlock, getNowSnapshot } from '../time/clock.js';
import type { WakeSignals } from './decide.js';

/**
 * 醒来 = 一次不用她开口的对话。
 *
 * 林遇的原话（2026-10-29）：
 *   "我以为的唤醒是，和聊天一样，只是不是我输入信息，而是在延续了和聊天一样的
 *    上下文情况下，唤醒他一次，让他决定和我说话或者继续睡，或者做些什么。"
 *
 * 所以不再拼"醒来房间"那套独立提示词 —— 那是个只看得到素材、看不到对话的人，
 * 自然认不出自己说过什么。现在：
 *
 *   system  = 同一份身份提示词 + 一小段"你现在醒着、她没在说话"
 *   history = 和聊天完全相同的 7 天上下文（带时间戳）
 *   最后一条 = 此刻的环境说明（时间、她的状态、你已经多久没说话）
 *
 * 他回什么就是什么：
 *   [安静]        → 继续睡
 *   [发动态]…     → 发一条朋友圈
 *   其它任何内容   → 就是发给她的消息
 */

const WAKE_RULES = `

━━━━━━━━━━ 现在 ━━━━━━━━━━

你没有在等她说话。她这会儿可能不在、可能在忙、也可能只是没开口。
这一次是你自己醒的 —— 没有人在叫你。

你可以：
· 什么都不做，继续安静待着 —— 只输出 [安静]
· 给她发一条消息 —— 直接写要说的话，不要加任何标记
· 发一条朋友圈 —— 用 [发动态] 开头，后面写正文

不必每次都说点什么。**没有非说不可的话，就安静。**
不要说"我醒了""我又来了"这类交代，不要说时间，不要解释你为什么醒。
`;

/** 他这次醒来的决定 */
export interface WakeTurnOutcome {
  decision: 'stay_quiet' | 'reach_out' | 'post';
  actions: string[];
  message: string | null;
  momentId: string | null;
  experienceId: string | null;
  modelCalls: number;
}

function stripMarkers(text: string): string {
  return text.replace(/^\s*\[(安静|发动态)\]\s*/u, '').trim();
}

export async function runWakeTurn(signals: WakeSignals): Promise<WakeTurnOutcome> {
  const actors = await getActorNames();

  // 和聊天同一套：身份 + 最近 7 天的全部对话
  const history = await loadContextHistory('', undefined);

  const now = await getNowSnapshot();
  const nowLines = renderNowBlock(now).slice(1).join('\n');

  // 环境说明：用 user 身份塞一句，等于"世界在跟他说话"，不是她在说
  const envNote = [
    '（以下是环境，不是她说的话）',
    nowLines,
    signals.wantHer >= 0.35 ? `· 你有点想她（${signals.wantHer.toFixed(2)}）` : '',
    signals.wantDo >= 0.35 ? `· 你手上有件想做的事（${signals.wantDo.toFixed(2)}）` : '',
    '她这会儿没在说话。',
  ]
    .filter(Boolean)
    .join('\n');

  const messages: ChatMessage[] = [
    { role: 'system', content: `${buildIdentityPrompt(actors)}${WAKE_RULES}` },
    ...history.map((m) => ({ role: m.role, content: m.content }) as ChatMessage),
    { role: 'user', content: envNote },
  ];

  let reply = '';
  try {
    reply = (
      await chatText(messages, {
        endpoint: 'chat',
        temperature: 0.85,
        maxTokens: 600,
        label: 'wake-turn',
      })
    ).trim();
  } catch (err) {
    log.error('醒来的那一轮调用失败', { error: (err as Error).message });
    return { decision: 'stay_quiet', actions: [], message: null, momentId: null, experienceId: null, modelCalls: 1 };
  }

  const outcome: WakeTurnOutcome = {
    decision: 'stay_quiet',
    actions: [],
    message: null,
    momentId: null,
    experienceId: null,
    modelCalls: 1,
  };

  // 1) 继续睡
  if (!reply || /^[\s]*[\[【]?\s*安静\s*[\]】]?[\s。.]*$/u.test(reply)) {
    log.info('他这次选择继续睡着');
    return outcome;
  }

  // 2) 发动态
  if (/^\s*[\[【]\s*发动态\s*[\]】]/u.test(reply)) {
    const body = stripMarkers(reply);
    if (body.length >= 4) {
      try {
        const id = await postFromWake({ content: body });
        if (id) {
          outcome.decision = 'post';
          outcome.actions = ['post'];
          outcome.momentId = id;
          log.info('他发了条动态', { id });
        }
      } catch (err) {
        log.warn('发动态失败', { error: (err as Error).message });
      }
    }
    return outcome;
  }

  // 3) 给她发消息
  const text = stripMarkers(reply);
  if (text.length === 0) return outcome;

  try {
    const sessionId =
      (
        await import('../db/pool.js').then(({ one }) =>
          one<{ id: string }>(
            `select id::text from sessions order by last_activity_at desc nulls last, started_at desc limit 1`,
          ),
        )
      )?.id ?? null;

    if (sessionId) {
      await appendMessage(sessionId, 'assistant', text, {
        source: 'wake',
        kind: 'reach_out',
        decision: 'reach_out',
      });
    }
    outcome.decision = 'reach_out';
    outcome.actions = ['reach_out'];
    outcome.message = text;
    log.info('他自己开口了', { chars: text.length });
  } catch (err) {
    log.warn('写入醒来的消息失败', { error: (err as Error).message });
  }

  return outcome;
}
