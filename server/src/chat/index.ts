import type { Response } from 'express';

import { log, errFields } from '../logger.js';
import { chatText, chatTextStream, type ChatMessage } from '../llm/client.js';
import { buildDriveHints } from '../drives/render.js';
import { processTurnSignals } from '../drives/signals.js';
import { compressOutOfWindow, compressWholeSession } from '../memory/compress/pipeline.js';
import { recall, type RecallResult } from '../memory/recall/index.js';
import { getTimelineLines } from '../memory/timeline/render.js';
import { buildContextBlock, buildIdentityPrompt } from './prompt.js';
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

export interface ChatRequest {
  message: string;
  sessionId?: string;
  endSession?: boolean;
}

export interface ChatResponse {
  reply: string;
  sessionId: string;
  recalled: { id: string; kind: string; routes: string[]; score: number }[];
  timing: { recallMs: number; llmMs: number; totalMs: number; firstTokenMs?: number };
}

const HISTORY_WINDOW = 20;

interface PreparedTurn {
  startedAt: number;
  text: string;
  actors: ActorNames;
  sessionId: string;
  recall: RecallResult;
  messages: ChatMessage[];
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
  await appendMessage(sessionId, 'user', text, { source: 'chat' });

  // 召回（阻塞：向量 + 关键词 + 一次裁决）
  const tRecall = Date.now();
  const rec = await recall(text);
  const recallMs = Date.now() - tRecall;

  // 近处原文（窗口内保持完整原文，远处才压缩成回忆）
  const recent = await recentMessages(sessionId, HISTORY_WINDOW + 1);
  const history = recent.slice(0, -1); // 去掉刚插入的当前这句

  const messages: ChatMessage[] = [{ role: 'system', content: buildIdentityPrompt(actors) }];
  const [timeline, driveHints] = await Promise.all([
    getTimelineLines().catch(() => [] as string[]),
    buildDriveHints().catch(() => [] as string[]),
  ]);
  const contextBlock = buildContextBlock({ recalled: rec.recalled, timeline, driveHints });
  if (contextBlock) messages.push({ role: 'system', content: contextBlock });
  for (const m of history) {
    messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
  }
  messages.push({ role: 'user', content: text });

  return {
    startedAt,
    text,
    actors,
    sessionId,
    recall: rec,
    messages,
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
): Promise<ChatResponse> {
  await appendMessage(turn.sessionId, 'assistant', reply, {
    source: 'chat',
    recalledIds: turn.recall.recalled.map((r) => r.id),
  });

  void compressOutOfWindow(turn.sessionId).catch((err) =>
    log.error('后台压缩失败（不影响本轮对话）', errFields(err)),
  );

  void processTurnSignals(turn.text, reply).catch((err) =>
    log.error('欲望信号处理失败（不影响本轮对话）', errFields(err)),
  );

  if (turn.endSession) {
    await closeSession(turn.sessionId);
    void compressWholeSession(turn.sessionId).catch((err) =>
      log.error('会话收尾压缩失败', errFields(err)),
    );
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
  const reply = await chatText(turn.messages, {
    endpoint: 'chat',
    temperature: 0.8,
    // 推理型模型会先花一大截预算在思考上（实测 1200 会被吃光、正文为空），
    // 所以对话这一层给足空间。
    maxTokens: 4000,
    label: 'reply',
  });

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

  try {
    full = await chatTextStream(
      turn.messages,
      { endpoint: 'chat', temperature: 0.8, maxTokens: 4000, label: 'reply-stream' },
      (delta) => {
        if (firstTokenMs === undefined) firstTokenMs = Date.now() - tLlm;
        send('delta', { t: delta });
      },
    );
  } catch (err) {
    log.error('流式对话失败', errFields(err));
    send('error', { message: String((err as Error)?.message ?? err).slice(0, 300) });
    res.end();
    return;
  }

  const llmMs = Date.now() - tLlm;
  const result = await finalizeTurn(turn, full, { llmMs, firstTokenMs });
  send('done', { ...result, firstTokenMs });
  res.end();
}
