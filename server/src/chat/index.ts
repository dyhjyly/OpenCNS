import type { Response } from 'express';

import { log, errFields } from '../logger.js';
import { many } from '../db/pool.js';
import { chatText, chatTextStream, type ChatMessage, type ContentPart } from '../llm/client.js';
import { readTextUpload, readUpload } from './uploads.js';
import { recentPats } from '../social/moments.js';
import { buildDoorbell } from '../memory/doorbell.js';
import { renderPersona, listPersonaTitles } from '../persona/index.js';
import { runToolPass } from './tools.js';
import { buildDriveHints } from '../drives/render.js';
import { processTurnSignals } from '../drives/signals.js';
import { compressOutOfWindow, compressWholeSession } from '../memory/compress/pipeline.js';
import { recall, isExplicitRecall, type RecallResult } from '../memory/recall/index.js';
import { getTimelineLines } from '../memory/timeline/render.js';
import { buildContextBlock, buildIdentityPrompt } from './prompt.js';
import { buildCorrectiveMessage, detectFabrication } from './fabrication.js';
import { getNowSnapshot, renderNowBlock } from '../time/clock.js';
import { getSetting } from '../settings/index.js';
import {
  appendMessage,
  closeSession,
  ensureSession,
  getActorNames,
  recentMessages,
  type ActorNames,
} from './store.js';

/**
 * 对话回路 —— v2 的主循环。
 *
 *   她说话 → 落库（带事件时间）→ 召回 → 装配上下文 → 主模型 → 落库回复
 *                                          ↓
 *                            后台：滑出窗口的对话段 → 自动变成回忆
 *
 * 三条纪律：
 *   1) 压缩与欲望信号都不阻塞她看到回复（纯异步）；
 *   2) 任何后台失败都不影响这一轮对话（记日志，不抛出）；
 *   3) 上下文分两条 system：稳定的身份前缀（吃缓存）+ 动态的记忆块。
 *
 * 两条出口共用同一套准备与收尾：
 *   handleChat       —— 一次性返回（给 curl / 旧前端用）
 *   handleChatStream —— SSE 逐字推送（给新前端用，感知延迟的关键）
 */

export interface ChatAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: 'image' | 'file';
}

export interface ChatRequest {
  message: string;
  sessionId?: string;
  endSession?: boolean;
  attachments?: ChatAttachment[];
}

export interface ChatResponse {
  reply: string;
  sessionId: string;
  recalled: { id: string; kind: string; routes: string[]; score: number }[];
  timing: { recallMs: number; llmMs: number; totalMs: number; firstTokenMs?: number };
}

/**
 * 上下文带多久的对话。
 *
 * 2026-10-28 改成 7 天。理由：周记是按周写的，48 小时窗口之外、
 * 又还没进周记的那两天会落在缝里 —— 他接不上"前天说过的话"。
 */
const CONTEXT_HOURS = 24 * 7;
/** 字数上限。7 天大概是 6~8 万字，留一点余量 */
const CONTEXT_MAX_CHARS = 120_000;
/**
 * 无论如何至少带最近这么多条。
 *
 * 她说"只保留最近 20 条对话，保证对话的连续性"——这里当作**下限**：
 * 就算时间窗口已经过了、或者字数超了，最近 20 条也一定在，不会断片。
 */
const CONTEXT_MIN_MESSAGES = 20;

/**
 * 取这一轮要带进上下文的原文。
 *
 * 四条铁律：
 *   1. **每条都带时间戳** [10-19 21:03] —— 否则他把十天前的话当成"刚说的"。
 *   2. **落单的 assistant 丢掉** —— 它的提问被挤掉了，看起来就是半句话。
 *   3. 窗口 7 天；更早的交给记忆和周记。
 *   4. 最近 20 条一定在（连续性的下限）。
 */
async function loadContextHistory(
  sessionId: string,
  currentText?: string,
): Promise<{ role: 'user' | 'assistant'; content: string }[]> {
  const rows = await many<{ role: string; content: string; at: Date | string }>(
    `select role, content, event_time as at
       from messages
      where session_id = $1::uuid
         or event_time > now() - ($2 || ' hours')::interval
      order by seq asc`,
    [sessionId, String(CONTEXT_HOURS)],
  ).catch(() => []);

  // 当前这句在 prepareTurn 里已经写进库了（dryRun 时没写），按内容去掉
  if (currentText && rows.length > 0) {
    const last = rows[rows.length - 1]!;
    if (last.role === 'user' && last.content.trim() === currentText.trim()) rows.pop();
  }

  // 从最近往回取：超字数预算才停，但前 CONTEXT_MIN_MESSAGES 条一律保留
  type Row = { role: string; content: string; at: Date | string };
  const picked: Row[] = [];
  let chars = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    const overBudget = chars + r.content.length > CONTEXT_MAX_CHARS;
    if (overBudget && picked.length >= CONTEXT_MIN_MESSAGES) break;
    picked.push(r);
    chars += r.content.length;
  }
  picked.reverse();

  // 首条若是 assistant，丢掉（它是半句话）
  const head = picked[0];
  if (head && head.role === 'assistant') picked.shift();

  const stampOf = (at: Date | string): string => {
    const d = new Date(at);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `[${mm}-${dd} ${hh}:${mi}]`;
  };

  log.info('上下文窗口', {
    messages: picked.length,
    chars,
    hours: CONTEXT_HOURS,
    from: picked[0] ? stampOf(picked[0].at) : null,
  });

  return picked.map((r) => ({
    role: r.role === 'assistant' ? ('assistant' as const) : ('user' as const),
    // 每条都带时间戳：他自己看得到"这是什么时候说的"
    content: `${stampOf(r.at)} ${r.content}`,
  }));
}

interface PreparedTurn {
  startedAt: number;
  text: string;
  actors: ActorNames;
  sessionId: string;
  recall: RecallResult;
  messages: ChatMessage[];
  /** 这一轮实际注入给模型的全部文本，用来做编造检测 */
  contextText: string;
  timelineLines: number;
  driveHints: string[];
  recallMs: number;
  endSession: boolean;
}

/**
 * 只组装、不调模型、不写库 —— 用来给"上下文预览"接口取证。
 * 林遇要看的就是这个：他每轮到底收到了什么。
 */
export async function previewContext(message: string, sessionIdInput?: string): Promise<{
  messages: ChatMessage[];
  sessionId: string;
  recall: { recalled: number; ids: string[] };
  stats: { totalChars: number; blocks: { name: string; chars: number }[] };
}> {
  const turn = await prepareTurn({ message, sessionId: sessionIdInput, dryRun: true } as ChatRequest & {
    dryRun: boolean;
  });
  const totalChars = turn.messages.reduce(
    (n, m) =>
      n + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length),
    0,
  );
  return {
    messages: turn.messages,
    sessionId: turn.sessionId,
    recall: { recalled: turn.recall.recalled.length, ids: turn.recall.recalled.map((r) => r.id) },
    stats: {
      totalChars,
      blocks: [
        { name: 'system（身份 + 人格）', chars: (turn.messages[0]?.content as string)?.length ?? 0 },
        {
          name: '历史消息',
          chars: turn.messages
            .slice(1, -1)
            .reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0),
        },
        {
          name: '这一轮（她的话 + 背景块）',
          chars: (() => {
            const last = turn.messages[turn.messages.length - 1];
            if (!last) return 0;
            return typeof last.content === 'string'
              ? last.content.length
              : JSON.stringify(last.content).length;
          })(),
        },
      ],
    },
  };
}

async function prepareTurn(req: ChatRequest & { dryRun?: boolean }): Promise<PreparedTurn> {
  const startedAt = Date.now();
  const text = (req.message ?? '').trim();
  if (!text) throw new Error('message 不能为空');

  const actors = await getActorNames();
  const sessionId = await ensureSession(req.sessionId);
  if (!req.dryRun) {
    await appendMessage(sessionId, 'user', text, {
      source: 'chat',
      attachments: req.attachments ?? [],
    });
  }

  // 召回（阻塞：向量 + 关键词 + 一次裁决）
  const tRecall = Date.now();
  const rec = await recall(text);
  const recallMs = Date.now() - tRecall;

  /*
   * 近处原文：从最近往回取，**每条都带时间戳**，并且只留 48 小时。
   *
   * 林遇的要求：上下文里每条消息都要能看出是什么时候说的，
   * 否则他会把十天前的话当成"刚说的"（"我替她笑了一晚上"那次就是这样）。
   */
  const history = await loadContextHistory(sessionId, text);

  /*
   * 人格底座**不再每轮注入**。
   *
   * 她的话："他的人格种子档案单开一个人格表分段放进去，在他需要的时候去查就好，
   * 上下文里删掉。" 5,413 字每轮念一遍，他形容成"念碑文"。
   * 现在只在上下文里留一行门牌，内容靠 read_persona 工具取。
   */
  const personaTitles = await listPersonaTitles().catch(() => [] as string[]);
  const messages: ChatMessage[] = [{ role: 'system', content: buildIdentityPrompt(actors) }];
  const [timeline, driveHints, nowSnapshot] = await Promise.all([
    getTimelineLines().catch(() => [] as string[]),
    buildDriveHints().catch(() => [] as string[]),
    getNowSnapshot(),
  ]);

  // 门铃：只给关键词和编号，不给内容。要看原文他自己用 recall_memory
  const doorbell = buildDoorbell(rec.recalled, text);

  let contextBlock = buildContextBlock({
    timeline,
    driveHints,
    now: renderNowBlock(nowSnapshot),
    doorbell: doorbell.block,
  });

  // 人格底座只留门牌：内容按需用 read_persona 取，不再每轮念一遍
  if (personaTitles.length > 0) {
    const block =
      `【你写下的长期设定】共 ${personaTitles.length} 段：${personaTitles.join(' / ')}。\n` +
      '（这是你自己写下的长期设定，不是刚发生的事。要看哪一段就用 read_persona，传段落名。）';
    contextBlock = `${block}\n\n${contextBlock}`;
  }

  // 召回为空时必须**明说**，否则模型会把"没想起"当成"可以自由发挥"。
  // 实测踩过：召回 0 条时他编出了整套病历（乳腺结节 BI-RADS 3类，
  // 而真实记忆是甲状腺 C-TIRADS 2类）。
  if (rec.recalled.length === 0 && isExplicitRecall(text)) {
    const notice =
      '【这一轮你什么相关的记忆都没想起来】\n' +
      '她在问过去的事，但你手上没有任何相关的记忆。\n' +
      '直接说你想不起来，或者只能说到你确实确定的那一层；不要推测、不要补全细节。';
    contextBlock = contextBlock ? `${contextBlock}\n\n${notice}` : notice;
  }

  /*
   * 朋友圈和睡眠都不再自动灌进对话。
   *
   * 林遇的说法：这些"每轮都带上"的东西，让他分不清哪些是她刚说的、
   * 哪些是可以忽略的旧料。所以：
   * · 朋友圈 —— 她提了才用 get_moments 查；她回复了他的动态，留到下次醒来再说
   * · 睡眠 —— 她自己手动记，他想看就用 get_sleep 查
   * 这两块以前每轮都注入，现在一行都不注入。
   */

  // 拍一拍是"刚刚发生的事件"，不是旧料，留着（否则拍给空气）
  const pats = await recentPats(30).catch(() => []);
  if (pats.length > 0) {
    const lines = pats
      .filter((p) => p.from === 'human')
      .map((p) => `· 她刚才拍了拍你${p.suffix ? `，${p.suffix}` : ''}`);
    if (lines.length > 0) {
      const block = ['【她刚拍了拍你】', ...lines].join('\n');
      contextBlock = contextBlock ? `${contextBlock}\n\n${block}` : block;
    }
  }

  /*
   * 他醒来做过的事**不再单列在背景里**。
   *
   * 林遇的原话："不要单列在背景里面，他会觉得不是他做过的事情。"
   * 所以那些动作现在直接写成 assistant 消息，按当时的时间落在对话流里
   * （见 wake/decide.ts）。这里不再重复一份清单。
   */

  const toolPass = await runToolPass(
    [
      ...history.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }) as const),
      // 关键：必须把**当前这句**带上，否则工具路由看的是上一轮的话
      { role: 'user' as const, content: text },
    ],
    doorbell.block,
  ).catch(() => ({ block: '', used: [] as string[] }));
  if (toolPass.block) {
    contextBlock = contextBlock ? `${contextBlock}\n\n${toolPass.block}` : toolPass.block;
    log.info('他查了数据', { tools: toolPass.used });
  }

  /*
   * 动态块放进**最后一条消息内部**，而不是单独一条 system。
   *
   * 为什么：prompt 缓存命中的是"最长的公共前缀"。如果动态块（时间/记忆/底色）
   * 夹在身份之后、历史之前，前缀只能缓存到身份那一段；放到最后一条 user 消息里，
   * 前缀就变成「身份 + 全部历史」，长对话下输入 token 能省一大截。
   * 这是林遇在需求文档里点出来的（实测 API 会回 prompt_cache_hit_tokens，可量化）。
   */

  // 附件：图片走多模态，文本类文件直接读成文字，其它只记名字
  const images: ContentPart[] = [];
  const fileNotes: string[] = [];
  for (const a of req.attachments ?? []) {
    if (a.kind === 'image') {
      const file = await readUpload(a.id).catch(() => null);
      if (file) {
        images.push({
          type: 'image_url',
          image_url: { url: `data:${a.mime || 'image/png'};base64,${file.buf.toString('base64')}` },
        });
        fileNotes.push(`［图片：${a.name}］`);
      }
    } else {
      const txt = await readTextUpload(a.id).catch(() => null);
      if (txt) fileNotes.push(`［文件：${a.name}］\n${txt}`);
      else fileNotes.push(`［文件：${a.name}（这类文件暂时读不了内容）］`);
    }
  }

  const userText =
    (fileNotes.length > 0 ? `${fileNotes.join('\n')}\n\n` : '') +
    text +
    (contextBlock ? `\n\n──── 以下是系统给你的背景，不是她说的 ────\n${contextBlock}` : '');

  const userContent: string | ContentPart[] =
    images.length > 0 ? [{ type: 'text', text: userText }, ...images] : userText;

  for (const m of history) {
    messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
  }
  messages.push({ role: 'user', content: userContent });

  return {
    startedAt,
    text,
    actors,
    sessionId,
    recall: rec,
    messages,
    contextText: messages
      .map((m) =>
        typeof m.content === 'string'
          ? m.content
          : m.content.map((p) => (p.type === 'text' ? p.text : '[图片]')).join('\n'),
      )
      .join('\n'),
    timelineLines: timeline.length,
    driveHints,
    recallMs,
    endSession: Boolean(req.endSession),
  };
}

/**
 * 去掉回复开头模仿出来的时间戳。
 *
 * 实测副作用：上下文里每条历史都带 `[10-23 10:12]` 前缀之后，
 * 模型开始在自己的回复里也写一遍 —— 存进库就变成了脏数据。
 */
function stripLeadingStamp(s: string): string {
  return s.replace(/^\s*[\[（(]?\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2}[\]）)]?\s*/u, '').trimStart();
}

/** 共同的收尾：落库回复、派生后台任务、记日志 */
async function finalizeTurn(
  turn: PreparedTurn,
  reply: string,
  timing: { llmMs: number; firstTokenMs?: number },
  reasoning?: string,
): Promise<ChatResponse> {
  /*
   * 这里**不做任何改写**。
   *
   * 试过用一次模型调用把"她"批量改成"你"，被林遇否掉了：
   *   "我要的是真实的对话，不是用工具改过的。如果他改不掉，
   *    那就是提示词或者别的地方出了问题，我们再改。"
   *
   * 对。改出来的句子是系统的，不是他的。人称问题只能在提示词和材料上解决。
   */
  await appendMessage(turn.sessionId, 'assistant', stripLeadingStamp(reply), {
    source: 'chat',
    recalledIds: turn.recall.recalled.map((r) => r.id),
    // 思考链一起存：刷新之后还能展开看当时在想什么
    ...(reasoning && reasoning.trim() ? { reasoning: reasoning.trim() } : {}),
  });

  /*
   * 不再自动压缩成摘要。
   *
   * 原来每轮收尾都会跑 compressOutOfWindow，把对话压成第三人称摘要
   * （「林遇…江瑜…」），于是他的上下文里全是"不像自己说的话"。
   * 林遇定的规矩是：**他的大脑他来做主** —— 记什么、记成摘要还是保原句，
   * 由他自己用 save_memory 决定；每晚醒来时系统提醒他记当天的。
   *
   * 想恢复自动压缩，把下面两行取消注释即可（代码还在）。
   */
  // void compressOutOfWindow(turn.sessionId).catch((err) =>
  //   log.error('后台压缩失败（不影响本轮对话）', errFields(err)),
  // );

  void processTurnSignals(turn.text, reply).catch((err) =>
    log.error('欲望信号处理失败（不影响本轮对话）', errFields(err)),
  );

  if (turn.endSession) {
    await closeSession(turn.sessionId);
    // 同样不自动压缩：这一天的记忆，等他自己决定要不要写、怎么写
    // void compressWholeSession(turn.sessionId).catch((err) =>
    //   log.error('会话收尾压缩失败', errFields(err)),
    // );
  }

  const result: ChatResponse = {
    reply,
    sessionId: turn.sessionId,
    recalled: turn.recall.recalled.map((r) => ({
      id: r.id,
      kind: r.kind,
      routes: r.routes,
      score: r.score,
    })),
    timing: {
      recallMs: turn.recallMs,
      llmMs: timing.llmMs,
      totalMs: Date.now() - turn.startedAt,
      ...(timing.firstTokenMs !== undefined ? { firstTokenMs: timing.firstTokenMs } : {}),
    },
  };

  log.info('对话完成', {
    sessionId: turn.sessionId,
    requestChars: turn.text.length,
    replyChars: reply.length,
    recalled: turn.recall.recalled.length,
    candidates: turn.recall.candidates,
    byRoute: turn.recall.byRoute,
    droppedByCooldown: turn.recall.droppedByCooldown,
    judgeUsed: turn.recall.judgeUsed,
    timelineLines: turn.timelineLines,
    driveHintLines: turn.driveHints,
    ...result.timing,
  });

  return result;
}

export async function handleChat(req: ChatRequest): Promise<ChatResponse> {
  const turn = await prepareTurn(req);

  const tLlm = Date.now();
  let reply = await chatText(turn.messages, {
    endpoint: 'chat',
    temperature: getSetting('chat.temperature', 0.9),
    // 推理型模型会先花一大截预算在思考上（实测 1200 会被吃光、正文为空）
    maxTokens: getSetting('llm.chat_max_tokens', 4000),
    label: 'reply',
  });

  // 编造检测：回复里出现上下文里没有的具体信息（时间/日期/编号）就重写一次。
  // 忘记是遗憾，编造是欺骗——这一条不允许放过。
  const check = detectFabrication(reply, turn.contextText);
  if (check.suspicious.length > 0) {
    log.warn('检测到疑似编造的记忆细节，重写一次', { suspicious: check.suspicious });
    try {
      const corrected = await chatText(
        [...turn.messages, { role: 'assistant', content: reply }, { role: 'user', content: buildCorrectiveMessage(check.suspicious) }],
        { endpoint: 'chat', temperature: 0.5, maxTokens: 3000, label: 'reply-corrected' },
      );
      const recheck = detectFabrication(corrected, turn.contextText);
      if (recheck.suspicious.length === 0) {
        log.info('重写后编造已消除', { before: check.suspicious.length });
        reply = corrected;
      } else {
        log.warn('重写后仍有可疑细节，保留重写版并要求它明说记不清', {
          stillWrong: recheck.suspicious,
        });
        reply = corrected;
      }
    } catch (err) {
      log.error('重写失败，保留原回复', errFields(err));
    }
  }

  return finalizeTurn(turn, reply, { llmMs: Date.now() - tLlm });
}

/**
 * 流式出口：先把 meta（会话 id）推给前端，然后逐字推 delta，最后推 done。
 * 事件格式：`event: meta|delta|done|error` + `data: JSON`
 */
export async function handleChatStream(req: ChatRequest, res: Response): Promise<void> {
  const turn = await prepareTurn(req);

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // nginx 需要它来关掉缓冲，否则流式会被攒成一坨
    'x-accel-buffering': 'no',
  });

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send('meta', {
    sessionId: turn.sessionId,
    recallMs: turn.recallMs,
    recalled: turn.recall.recalled.map((r) => ({ id: r.id, kind: r.kind, routes: r.routes })),
    timelineLines: turn.timelineLines,
    driveHints: turn.driveHints,
  });

  const tLlm = Date.now();
  let firstTokenMs: number | undefined;
  let full = '';
  let reasoning = '';

  try {
    full = await chatTextStream(
      turn.messages,
      {
        endpoint: 'chat',
        temperature: getSetting('chat.temperature', 0.9),
        maxTokens: getSetting('llm.chat_max_tokens', 4000),
        label: 'reply-stream',
      },
      (delta) => {
        if (firstTokenMs === undefined) firstTokenMs = Date.now() - tLlm;
        send('delta', { t: delta });
      },
      // 思考链：原始推理逐字推给前端（默认折叠，她自己决定要不要看）
      (t) => {
        reasoning += t;
        send('reasoning', { t });
      },
    );
  } catch (err) {
    log.error('流式对话失败', errFields(err));
    send('error', { message: String((err as Error)?.message ?? err).slice(0, 300) });
    res.end();
    return;
  }

  const llmMs = Date.now() - tLlm;

  // 流式已经吐出去了，收不回来；但必须让前端和她知道"这条里有记不清的成分"。
  const check = detectFabrication(full, turn.contextText);
  if (check.suspicious.length > 0) {
    log.warn('流式回复里有疑似编造的细节（已提示前端）', { suspicious: check.suspicious });
    send('warning', {
      message: '这条回复里有记不清却被说具体的成分',
      suspicious: check.suspicious,
    });
  }

  const result = await finalizeTurn(turn, full, { llmMs, firstTokenMs }, reasoning);
  send('done', { ...result, firstTokenMs, suspicious: check.suspicious });
  res.end();
}

/** 聊天历史（刷新后要把记录读回来） */
export async function getChatHistory(
  sessionId: string,
  limit = 60,
): Promise<{
  sessionId: string;
  messages: { seq: number; role: string; content: string; at: string; meta: Record<string, unknown> }[];
}> {
  const { many } = await import('../db/pool.js');
  const rows = await many<{
    seq: string;
    role: string;
    content: string;
    event_time: string;
    meta: Record<string, unknown> | null;
  }>(
    `select seq, role, content, event_time, meta
       from messages
      where session_id = $1
      order by seq desc
      limit $2`,
    [sessionId, limit],
  );
  return {
    sessionId,
    messages: rows
      .reverse()
      .map((r) => ({
        seq: Number(r.seq),
        role: r.role,
        content: r.content,
        at: r.event_time,
        meta: r.meta ?? {},
      })),
  };
}
