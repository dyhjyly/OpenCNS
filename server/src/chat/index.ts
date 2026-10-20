import type { Response } from 'express';

import { log, errFields } from '../logger.js';
import { many } from '../db/pool.js';
import { chatText, chatTextStream, type ChatMessage, type ContentPart } from '../llm/client.js';
import { readTextUpload, readUpload } from './uploads.js';
import { recentPats } from '../social/moments.js';
import { buildDoorbell } from '../memory/doorbell.js';
import { selfActivityLines } from '../memory/self-activity.js';
import { renderPersona } from '../persona/index.js';
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

const HISTORY_WINDOW = 20;

/** 上下文带多少天的对话（开新窗也要有熟悉感） */
const CONTEXT_DAYS = 5;
/** 字数上限。中文约 1 字 ≈ 0.7 token，120,000 字 ≈ 8 万 tokens，离 100 万还很远 */
const CONTEXT_MAX_CHARS = 120_000;

/**
 * 取这一轮要带进上下文的原文。
 *
 * 两条腿：
 *   1. 当前会话的全部（同一场对话不该断）
 *   2. 最近 5 天里其它会话的消息（开新窗也认得前面）
 * 从最近往回取，超字数预算就停。
 */
async function loadContextHistory(sessionId: string): Promise<{ role: 'user' | 'assistant'; content: string }[]> {
  const rows = await many<{ role: string; content: string }>(
    `select role, content
       from messages
      where session_id = $1::uuid
         or event_time > now() - ($2 || ' days')::interval
      order by seq asc`,
    [sessionId, String(CONTEXT_DAYS)],
  ).catch(() => []);

  // 当前这句在 prepareTurn 里已经写进库了，去掉
  if (rows.length > 0) rows.pop();

  const picked: { role: string; content: string }[] = [];
  let chars = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (picked.length > 0 && chars + r.content.length > CONTEXT_MAX_CHARS) break;
    picked.push(r);
    chars += r.content.length;
  }
  picked.reverse();

  log.info('上下文窗口', { messages: picked.length, chars, days: CONTEXT_DAYS });
  return picked.map((r) => ({ role: r.role === 'assistant' ? ('assistant' as const) : ('user' as const), content: r.content }));
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

async function prepareTurn(req: ChatRequest): Promise<PreparedTurn> {
  const startedAt = Date.now();
  const text = (req.message ?? '').trim();
  if (!text) throw new Error('message 不能为空');

  const actors = await getActorNames();
  const sessionId = await ensureSession(req.sessionId);
  await appendMessage(sessionId, 'user', text, {
    source: 'chat',
    attachments: req.attachments ?? [],
  });

  // 召回（阻塞：向量 + 关键词 + 一次裁决）
  const tRecall = Date.now();
  const rec = await recall(text);
  const recallMs = Date.now() - tRecall;

  /*
   * 近处原文。
   *
   * 原来是硬编码 20 条（HISTORY_WINDOW），一场长对话超过 20 条就开始丢前面的 ——
   * "聊着聊着忘了刚才说过什么"就是这个原因，不是上下文满了。
   *
   * 实测：模型上下文 1,048,576 tokens，我们现在每轮才用 4,535（0.43%）。
   * 所以放开：**当前会话的全部 + 最近 5 天的所有对话**，按字数封顶，
   * 保证开新窗也有熟悉感。
   */
  const history = await loadContextHistory(sessionId);

  // 人格底座：他自己写下的相处模式，每一轮都在（不是记忆，是他）
  const persona = await renderPersona().catch(() => '');
  const systemPrompt = persona
    ? `${buildIdentityPrompt(actors)}\n\n${persona}`
    : buildIdentityPrompt(actors);
  const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }];
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

  // 今天你自己做过的事（醒来、发过的消息、发过的动态）—— 否则聊天里他不认自己做过什么
  const selfActs = await selfActivityLines().catch(() => [] as string[]);
  if (selfActs.length > 0) {
    const block = ['【今天你自己做过的事】（这些是你做的，不是她说的）', ...selfActs].join('\n');
    contextBlock = contextBlock ? `${contextBlock}\n\n${block}` : block;
  }
  log.info('自己的近况', { lines: selfActs.length });

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

/** 共同的收尾：落库回复、派生后台任务、记日志 */
async function finalizeTurn(
  turn: PreparedTurn,
  reply: string,
  timing: { llmMs: number; firstTokenMs?: number },
  reasoning?: string,
): Promise<ChatResponse> {
  await appendMessage(turn.sessionId, 'assistant', reply, {
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
