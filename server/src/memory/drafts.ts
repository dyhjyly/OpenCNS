import { many, one, query } from '../db/pool.js';
import { embedOne } from '../embedding/index.js';
import { log, errFields } from '../logger.js';

/**
 * 待审记忆。
 *
 * 他写下的记忆先落在这里，等林遇看过才进正式记忆库。
 * 这样她能回答"他到底存进去了没有"——不用猜。
 */

export interface Draft {
  id: string;
  kind: string;
  content: string;
  quotes: unknown;
  causal: string | null;
  eventTime: string | null;
  importance: number;
  via: string;
  status: string;
  createdAt: string;
}

export async function createDraft(input: {
  kind: string;
  content: string;
  quotes?: unknown;
  causal?: string | null;
  eventTime?: string | null;
  importance?: number;
  via: string;
}): Promise<string | null> {
  const row = await one<{ id: string }>(
    `insert into memory_drafts (kind, content, quotes, causal, event_time, importance, via)
     values ($1, $2, $3::jsonb, $4, $5, $6, $7) returning id::text`,
    [
      input.kind,
      input.content,
      JSON.stringify(input.quotes ?? []),
      input.causal ?? null,
      input.eventTime ?? null,
      input.importance ?? 0.5,
      input.via,
    ],
  );
  return row?.id ?? null;
}

export async function listDrafts(status = 'pending', limit = 50): Promise<Draft[]> {
  const rows = await many<{
    id: string;
    kind: string;
    content: string;
    quotes: unknown;
    causal: string | null;
    event_time: string | null;
    importance: number;
    via: string;
    status: string;
    created_at: string;
  }>(
    `select id::text, kind, content, quotes, causal, event_time, importance, via, status, created_at
       from memory_drafts
      where ($1 = 'all' or status = $1)
      order by created_at desc limit $2`,
    [status, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    content: r.content,
    quotes: r.quotes,
    causal: r.causal,
    eventTime: r.event_time,
    importance: Number(r.importance),
    via: r.via,
    status: r.status,
    createdAt: r.created_at,
  }));
}

export async function pendingCount(): Promise<number> {
  const row = await one<{ n: number }>(
    `select count(*)::int as n from memory_drafts where status = 'pending'`,
  );
  return row?.n ?? 0;
}

/** 批准：可以顺手改内容，然后真正插进 memory_items */
export async function approveDraft(
  id: string,
  patch?: { content?: string; eventTime?: string; kind?: string; importance?: number },
): Promise<{ ok: boolean; memoryId?: string; error?: string }> {
  const d = await one<{
    id: string;
    kind: string;
    content: string;
    quotes: unknown;
    causal: string | null;
    event_time: string | null;
    importance: number;
    status: string;
    via: string;
  }>(
    `select id::text, kind, content, quotes, causal, event_time, importance, status, via
       from memory_drafts where id = $1::uuid`,
    [id],
  );
  if (!d) return { ok: false, error: '找不到这条' };
  if (d.status !== 'pending') return { ok: false, error: `这条已经${d.status === 'approved' ? '批准过' : '驳回过'}` };

  const kind = patch?.kind && ['episode', 'semantic', 'experience', 'reflection'].includes(patch.kind) ? patch.kind : d.kind;
  const content = (patch?.content ?? d.content).trim();
  if (!content) return { ok: false, error: '内容不能为空' };

  const importance =
    typeof patch?.importance === 'number' && Number.isFinite(patch.importance)
      ? Math.min(1, Math.max(0.1, patch.importance))
      : Number(d.importance);

  let eventTime: string | null = d.event_time;
  if (patch?.eventTime) {
    const dt = new Date(patch.eventTime);
    if (!Number.isNaN(dt.getTime())) eventTime = dt.toISOString();
  }

  let vec: string | null = null;
  try {
    vec = `[${(await embedOne(content.slice(0, 2000))).join(',')}]`;
  } catch (err) {
    log.warn('批准记忆时嵌入失败', errFields(err));
  }

  try {
    /*
     * 注意：memory_items.causal 是 **jsonb**（存四环对象 happened/reaction/act/outcome），
     * 而草稿里存的是纯文本。
     *
     * 之前直接把 text 塞进 jsonb 列，PostgreSQL 会按 JSON 解析这段中文，
     * 于是报 `invalid input syntax for type json` —— 审核通过永远 400。
     * 现在用 to_jsonb($4::text)：存成 JSON 字符串，读出来还是原文。
     */
    const mem = await one<{ id: string }>(
      `insert into memory_items (
         kind, origin, subject, content, quotes, causal,
         event_time, event_time_precision, ingested_at,
         privacy, state, importance, decay_score, embedding, provenance
       ) values (
         $1, 'self', 'shared', $2, $3::jsonb, to_jsonb($4::text),
         $5, $6, now(),
         'private', 'active', $7, 1.0, $8::vector, $9::jsonb
       ) returning id::text`,
      [
        kind,
        content,
        JSON.stringify(d.quotes ?? []),
        d.causal,
        eventTime,
        eventTime ? 'exact' : 'day',
        importance,
        vec,
        JSON.stringify({ source: 'self', via: d.via, approved: true }),
      ],
    );
    if (!mem) return { ok: false, error: '写进记忆库失败' };

    await query(
      `update memory_drafts set status = 'approved', reviewed_at = now(), memory_id = $2 where id = $1::uuid`,
      [id, mem.id],
    );
    return { ok: true, memoryId: mem.id };
  } catch (err) {
    log.error('批准记忆失败', errFields(err));
    return { ok: false, error: String((err as Error)?.message ?? err).slice(0, 160) };
  }
}

export async function rejectDraft(id: string, note?: string): Promise<boolean> {
  const row = await one<{ id: string }>(
    `update memory_drafts set status = 'rejected', reviewed_at = now(), note = $2
      where id = $1::uuid and status = 'pending' returning id::text`,
    [id, note ?? null],
  );
  return Boolean(row);
}
