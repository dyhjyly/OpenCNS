import { one } from '../db/pool.js';
import { embedOne } from '../embedding/index.js';
import { log, errFields } from '../logger.js';

/**
 * 他自己决定记什么。
 *
 * 原来这段是 compressor 管线自动干的：每轮把对话压成一段第三人称摘要，
 * 于是他的上下文里全是"林遇…江瑜…"这种不像自己说的话。
 * 现在改成：**他调用 save_memory 才记**，摘要还是保原句也由他决定。
 *
 * 数据库的硬约束不放松（episode 必须有原句和因果、正文至少 80 字），
 * 但失败时返回一句**能改**的话，让他自己补。
 */

export interface SaveMemoryInput {
  kind: string;
  content: string;
  quotes?: { who?: string; text?: string }[];
  causal?: string;
  eventTime?: string;
  importance?: number;
}

const KINDS = new Set(['episode', 'semantic', 'experience', 'reflection']);

/** 去掉控制字符：它们会让 jsonb 参数直接报 invalid input syntax */
function clean(s: unknown): string {
  return String(s ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .trim();
}

function safeJson(v: unknown, fallback = '[]'): string {
  try {
    const out = JSON.stringify(v ?? []);
    return typeof out === 'string' ? out : fallback;
  } catch {
    return fallback;
  }
}

function vectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`;
}

export async function saveMemory(input: SaveMemoryInput): Promise<string> {
  const kind = KINDS.has(input.kind) ? input.kind : 'semantic';
  const content = clean(input.content);
  if (!content) return '没写成：content 不能为空。';

  // 模型偶尔会把 quotes 给成字符串数组或对象，这里都兜住
  const rawQuotes = Array.isArray(input.quotes)
    ? input.quotes
    : typeof input.quotes === 'string'
      ? [{ text: input.quotes }]
      : [];
  const quotes = (rawQuotes as unknown[])
    .map((q) => {
      if (typeof q === 'string') return { who: 'human', text: clean(q) };
      const o = (q ?? {}) as { who?: unknown; text?: unknown };
      return { who: o.who === 'self' ? 'self' : 'human', text: clean(o.text) };
    })
    .filter((q) => q.text.length > 0);
  const causal = clean(input.causal);

  // 数据库的约束，先在应用层挡掉，并把"怎么改"说给他听
  if (kind === 'episode') {
    if (quotes.length === 0) return '没写成：episode 必须带 quotes（她或你说的原句）。';
    if (!causal) return '没写成：episode 必须带 causal（为什么这件事重要）。';
    if (content.length < 80) {
      return `没写成：episode 的正文至少 80 字，现在 ${content.length} 字。要么写长一点，要么改记成 semantic。`;
    }
  }

  let eventTime: string | null = null;
  if (input.eventTime) {
    const d = new Date(input.eventTime);
    if (!Number.isNaN(d.getTime())) eventTime = d.toISOString();
  }

  let embedding: string | null = null;
  try {
    embedding = vectorLiteral(await embedOne(content.slice(0, 2000)));
  } catch (err) {
    log.warn('存记忆时嵌入失败，先不带向量', errFields(err));
  }

  try {
    const row = await one<{ id: string }>(
      `insert into memory_items (
         kind, origin, subject, content, quotes, causal,
         event_time, event_time_precision, ingested_at,
         privacy, state, importance, decay_score, embedding, provenance
       ) values (
         $1, 'self', 'shared', $2, $3::jsonb, $4,
         $5, $6, now(),
         'private', 'active', $7, 1.0, $8::vector, $9::jsonb
       ) returning id`,
      [
        kind,
        content,
        safeJson(quotes),
        causal || null,
        eventTime,
        eventTime ? 'exact' : 'unknown',
        Math.min(1, Math.max(0.1, input.importance ?? 0.5)),
        embedding,
        safeJson({ source: 'self', via: 'save_memory' }, '{}'),
      ],
    );
    if (!row) return '没写成：数据库没返回 id。';
    log.info('他自己记下了一条', { kind, id: row.id.slice(0, 8), chars: content.length, hasVector: Boolean(embedding) });
    return `记下了（${kind}，编号 ${row.id.slice(0, 8)}${eventTime ? `，日期 ${eventTime.slice(0, 10)}` : '，没有日期'}）。`;
  } catch (err) {
    log.error('存记忆失败', errFields(err));
    return `没写成：${String((err as Error)?.message ?? err).slice(0, 160)}`;
  }
}
