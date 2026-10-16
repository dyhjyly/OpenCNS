import { log, errFields } from '../logger.js';
import { chatText, type ChatMessage } from '../llm/client.js';
import { compressOutOfWindow, compressWholeSession } from '../memory/compress/pipeline.js';
import { recall } from '../memory/recall/index.js';
import { getTimelineLines } from '../memory/timeline/render.js';
import { buildContextBlock, buildIdentityPrompt } from './prompt.js';
import { appendMessage, closeSession, ensureSession, getActorNames, recentMessages } from './store.js';

/**
 * 对话回路 —— v2 的主循环。
 *
 *   她说话 → 落库（带事件时间）→ 召回 → 装配上下文 → 主模型 → 落库回复
 *                                          ↓
 *                            后台：滑出窗口的对话段 → 自动变成回忆
 *
 * 三条纪律：
 *   1) 召回与压缩都不阻塞她看到回复（压缩纯异步）；
 *   2) 任何后台失败都不影响这一轮对话（记日志，不抛出）；
 *   3) 上下文分两条 system：稳定的身份前缀（吃缓存）+ 动态的记忆块。
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
  timing: { recallMs: number; llmMs: number; totalMs: number };
}

const HISTORY_WINDOW = 20;

export async function handleChat(req: ChatRequest): Promise<ChatResponse> {
  const started = Date.now();
  const text = (req.message ?? '').trim();
  if (!text) throw new Error('message 不能为空');

  const actors = await getActorNames();
  const sessionId = await ensureSession(req.sessionId);

  await appendMessage(sessionId, 'user', text, { source: 'chat' });

  // ---- 召回（阻塞，但很快：向量 + 关键词 + 一次裁决）----
  const tRecall = Date.now();
  const rec = await recall(text);
  const recallMs = Date.now() - tRecall;

  // ---- 近处原文（窗口内保持完整原文，远处才压缩成回忆）----
  const recent = await recentMessages(sessionId, HISTORY_WINDOW + 1);
  const history = recent.slice(0, -1); // 去掉刚插入的当前这句

  const messages: ChatMessage[] = [{ role: 'system', content: buildIdentityPrompt(actors) }];
  // 时间树是"第二通道"，每轮固定在场；读取失败不影响对话
  const timeline = await getTimelineLines().catch(() => [] as string[]);
  const contextBlock = buildContextBlock({ recalled: rec.recalled, timeline });
  if (contextBlock) messages.push({ role: 'system', content: contextBlock });
  for (const m of history) {
    messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
  }
  messages.push({ role: 'user', content: text });

  // ---- 主模型 ----
  const tLlm = Date.now();
  const reply = await chatText(messages, {
    endpoint: 'chat',
    temperature: 0.8,
    maxTokens: 1200,
    label: 'reply',
  });
  const llmMs = Date.now() - tLlm;

  await appendMessage(sessionId, 'assistant', reply, {
    source: 'chat',
    recalledIds: rec.recalled.map((r) => r.id),
  });

  // ---- 后台：滑出窗口的对话自动变回忆（不阻塞她看到回复）----
  void compressOutOfWindow(sessionId).catch((err) =>
    log.error('后台压缩失败（不影响本轮对话）', errFields(err)),
  );

  if (req.endSession) {
    await closeSession(sessionId);
    void compressWholeSession(sessionId).catch((err) =>
      log.error('会话收尾压缩失败', errFields(err)),
    );
  }

  const timing = { recallMs, llmMs, totalMs: Date.now() - started };
  log.info('对话完成', {
    sessionId,
    requestChars: text.length,
    replyChars: reply.length,
    recalled: rec.recalled.length,
    candidates: rec.candidates,
    byRoute: rec.byRoute,
    droppedByCooldown: rec.droppedByCooldown,
    judgeUsed: rec.judgeUsed,
    ...timing,
  });

  return {
    reply,
    sessionId,
    recalled: rec.recalled.map((r) => ({ id: r.id, kind: r.kind, routes: r.routes, score: r.score })),
    timing,
  };
}
