import { many, one } from '../db/pool.js';
import { log, errFields } from '../logger.js';

/**
 * 记忆星图。
 *
 * 问题：900 多条记忆，怎么摆到一张图上才不是随机撒点？
 *
 * 做法：**随机投影**。取两条固定的随机单位向量当坐标轴，每个记忆的
 * 向量和这两条轴做余弦相似度 —— 这就是一次线性降维（Johnson–Lindenstrauss），
 * 相近的记忆会落在相近的位置，图上自然出现"星团"。
 *
 * 为什么在 SQL 里算：pgvector 的 `<=>` 就是余弦距离，`1 - (a <=> b)` 就是余弦相似度。
 * 一条语句同时算出 900 个点的 x/y，payload 只有三个数一行，
 * 不用把 900×1024 的向量捞到 Node 里（那是 6MB）。
 */

/** 两条固定的随机投影轴（种子固定，所以每次打开星图布局都一样） */
const AXIS_X = randomUnitVector(1024, 20260523);
const AXIS_Y = randomUnitVector(1024, 19970703);

/** 线性同余伪随机，保证跨进程稳定 */
function randomUnitVector(dim: number, seed: number): number[] {
  let s = seed >>> 0;
  const out: number[] = new Array(dim);
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const v = (s / 0xffffffff) * 2 - 1;
    out[i] = v;
    norm += v * v;
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) out[i] = out[i]! / norm;
  return out;
}

const toVectorLiteral = (v: number[]) => `[${v.join(',')}]`;

export interface StarPoint {
  id: string;
  kind: string;
  pinned: boolean;
  importance: number;
  eventTime: string | null;
  at: string;
  /** 投影坐标，已归一到 0~1 */
  x: number;
  y: number;
  /** 显示用的短句（不给全文，星图上也不需要） */
  head: string;
  emotion: { v: number | null; a: number | null };
}

export interface StarMap {
  count: number;
  points: StarPoint[];
  kinds: { kind: string; n: number }[];
}

const cache = new Map<string, { at: number; data: StarMap }>();
const TTL = 5 * 60_000;

export async function getStarMap(): Promise<StarMap> {
  const total = await one<{ n: number }>(`select count(*)::int as n from memory_items where embedding is not null`);
  const key = String(total?.n ?? 0);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.data;

  try {
    const rows = await many<{
      id: string;
      kind: string;
      pinned: boolean;
      importance: number;
      event_time: string | null;
      ingested_at: string;
      head: string;
      v: number | null;
      a: number | null;
      px: number;
      py: number;
    }>(
      `select id, kind, pinned, importance, event_time, ingested_at,
              left(content, 26) as head,
              emotion_valence as v, emotion_arousal as a,
              1 - (embedding <=> $1::vector) as px,
              1 - (embedding <=> $2::vector) as py
         from memory_items
        where embedding is not null
          and state in ('active','archived')
        order by importance desc`,
      [toVectorLiteral(AXIS_X), toVectorLiteral(AXIS_Y)],
    );

    // 归一化到 0~1（投影值本身集中在很窄的区间里，不拉伸会全挤成一团）
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const r of rows) {
      const x = Number(r.px);
      const y = Number(r.py);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const spanX = maxX - minX || 1;
    const spanY = maxY - minY || 1;

    const points: StarPoint[] = rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      pinned: r.pinned,
      importance: Number(r.importance),
      eventTime: r.event_time,
      at: r.ingested_at,
      x: (Number(r.px) - minX) / spanX,
      y: (Number(r.py) - minY) / spanY,
      head: r.head,
      emotion: { v: r.v === null ? null : Number(r.v), a: r.a === null ? null : Number(r.a) },
    }));

    const kindRows = await many<{ kind: string; n: number }>(
      `select kind, count(*)::int as n from memory_items
        where embedding is not null and state in ('active','archived')
        group by 1 order by 2 desc`,
    );

    const data: StarMap = { count: points.length, points, kinds: kindRows };
    cache.set(key, { at: Date.now(), data });
    log.info('星图已重算', { points: points.length, kinds: kindRows.length });
    return data;
  } catch (err) {
    log.error('星图计算失败', errFields(err));
    return { count: 0, points: [], kinds: [] };
  }
}

/** 点开一颗星 */
export async function getMemoryItem(id: string): Promise<Record<string, unknown> | null> {
  const row = await one<Record<string, unknown>>(
    `select id, kind, origin, subject, content, quotes, causal,
            event_time, event_time_precision, ingested_at,
            privacy, state, importance, decay_score, recall_count,
            emotion_valence as emotion_v, emotion_arousal as emotion_a,
            pinned, pinned_rank, keywords, provenance, merged_into, superseded_by
       from memory_items where id = $1`,
    [id],
  );
  return row ?? null;
}

export interface SearchInput {
  q?: string;
  kind?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export async function searchMemories(input: SearchInput): Promise<{ rows: Record<string, unknown>[]; count: number }> {
  const limit = Math.min(100, Math.max(1, input.limit ?? 30));
  const cond: string[] = [`state in ('active','archived')`];
  const params: unknown[] = [];

  if (input.kind) {
    params.push(input.kind);
    cond.push(`kind = $${params.length}`);
  }
  if (input.from) {
    params.push(input.from);
    cond.push(`coalesce(event_time, ingested_at) >= $${params.length}::timestamptz`);
  }
  if (input.to) {
    params.push(input.to);
    cond.push(`coalesce(event_time, ingested_at) <= $${params.length}::timestamptz`);
  }
  if (input.q && input.q.trim()) {
    params.push(`%${input.q.trim()}%`);
    cond.push(`content like $${params.length}`);
  }

  params.push(limit);
  const rows = await many<Record<string, unknown>>(
    `select id, kind, left(content, 60) as head, content, event_time, ingested_at,
            importance, pinned, emotion_valence as emotion_v
       from memory_items
      where ${cond.join(' and ')}
      order by coalesce(event_time, ingested_at) desc
      limit $${params.length}`,
    params,
  );
  return { rows, count: rows.length };
}
