import { many, one, query } from '../db/pool.js';
import { log } from '../logger.js';

/**
 * 记忆整理。
 *
 * 现状：991 条记忆里 781 条没有日期，其中大部分是旧系统遗留下来的
 * 第三人称摘要（「林遇…江瑜…」）。它们被召回时会混进当前对话，
 * 而且没有日期就没法判断"这是什么时候的事"。
 *
 * 所以给她一个能筛的界面：一条一条看，删掉没必要的，有必要留的自己打上时间。
 */

export interface ReviewItem {
  id: string;
  kind: string;
  origin: string;
  subject: string;
  content: string;
  quotes: unknown;
  eventTime: string | null;
  ingestedAt: string;
  source: string;
  importance: number;
  pinned: boolean;
  /** 第三人称（「他/她/林遇/江瑜」作主语）—— 摘要的典型特征 */
  thirdPerson: boolean;
}

const THIRD = /(林遇|江瑜|他|她)(说|问|答|做了|写了|让|给|把|的)/;

function mapRow(r: {
  id: string;
  kind: string;
  origin: string;
  subject: string;
  content: string;
  quotes: unknown;
  event_time: string | null;
  ingested_at: string;
  source: string | null;
  importance: number;
  pinned: boolean;
}): ReviewItem {
  return {
    id: r.id,
    kind: r.kind,
    origin: r.origin,
    subject: r.subject,
    content: r.content,
    quotes: r.quotes,
    eventTime: r.event_time,
    ingestedAt: r.ingested_at,
    source: r.source ?? '(无)',
    importance: r.importance,
    pinned: r.pinned,
    thirdPerson: THIRD.test(r.content),
  };
}

export async function listForReview(opts: {
  filter: 'no_time' | 'third_person' | 'all';
  limit: number;
  offset: number;
}): Promise<ReviewItem[]> {
  const where: string[] = [`state = 'active'`, `pinned = false`];
  if (opts.filter === 'no_time') where.push('event_time is null');
  if (opts.filter === 'third_person') {
    where.push(`(content like '%林遇%' or content like '%江瑜%')`);
  }

  const rows = await many<{
    id: string;
    kind: string;
    origin: string;
    subject: string;
    content: string;
    quotes: unknown;
    event_time: string | null;
    ingested_at: string;
    source: string | null;
    importance: number;
    pinned: boolean;
  }>(
    `select id::text, kind, origin, subject, content, quotes,
            event_time, ingested_at, provenance->>'source' as source, importance, pinned
       from memory_items
      where ${where.join(' and ')}
      order by ingested_at desc
      limit $1 offset $2`,
    [opts.limit, opts.offset],
  );
  return rows.map(mapRow);
}

export interface ReviewStats {
  total: number;
  noTime: number;
  thirdPerson: number;
  bySource: { source: string; n: number }[];
}

export async function reviewStats(): Promise<ReviewStats> {
  const row = await one<{ total: number; no_time: number; third: number }>(
    `select count(*)::int as total,
            count(*) filter (where event_time is null)::int as no_time,
            count(*) filter (where content like '%林遇%' or content like '%江瑜%')::int as third
       from memory_items where state = 'active' and pinned = false`,
  );
  const bySource = await many<{ source: string; n: number }>(
    `select coalesce(provenance->>'source', '(无)') as source, count(*)::int as n
       from memory_items where state = 'active' and pinned = false
      group by 1 order by 2 desc`,
  );
  return {
    total: row?.total ?? 0,
    noTime: row?.no_time ?? 0,
    thirdPerson: row?.third ?? 0,
    bySource,
  };
}

/** 补日期 */
export async function setMemoryTime(id: string, eventTime: string): Promise<boolean> {
  const d = new Date(eventTime);
  if (Number.isNaN(d.getTime())) return false;
  const row = await one<{ id: string }>(
    `update memory_items
        set event_time = $2, event_time_precision = 'exact'
      where id = $1::uuid returning id::text`,
    [id, d.toISOString()],
  );
  return Boolean(row);
}

/** 删掉（软删：state 变成 pruned，召回和星图都不再出现） */
export async function deleteMemory(id: string): Promise<boolean> {
  // 注意：state 的 CHECK 只允许 active / archived / compressed_into /
  // merged_into / superseded / pruned —— 之前写 deleted 会直接报错
  const row = await one<{ id: string }>(
    `update memory_items set state = 'pruned' where id = $1::uuid and pinned = false returning id::text`,
    [id],
  );
  return Boolean(row);
}

/** 批量删：按来源（比如把 compressor 生成的第三人称摘要一次性清掉） */
export async function deleteBySource(source: string): Promise<number> {
  const rows = await many<{ id: string }>(
    `update memory_items set state = 'pruned'
      where state = 'active' and pinned = false and provenance->>'source' = $1
      returning id::text`,
    [source],
  );
  log.info('批量删记忆', { source, count: rows.length });
  return rows.length;
}

/** 批量删：按 kind（比如把所有 reflection 清掉） */
export async function deleteByKind(kind: string): Promise<number> {
  const rows = await many<{ id: string }>(
    `update memory_items set state = 'pruned'
      where state = 'active' and pinned = false and kind = $1
      returning id::text`,
    [kind],
  );
  log.info('批量删记忆（按类型）', { kind, count: rows.length });
  return rows.length;
}
