import { many, one, query } from '../db/pool.js';
import { log } from '../logger.js';

/**
 * 自省沉淀。
 *
 * 参照 Ombre-Brain 的 feel / I：
 *   · 他写下"我觉得……" —— 那是一个**候选**，还不是定论
 *   · 以后某天又被同一件事撞上，算一次**见证**
 *   · 三个**不同日期**的见证之后，才算立住
 *
 * 系统只做计数和摆放材料，**不判断谁支持谁、谁和谁矛盾** ——
 * 那是他自己的事（他们 rule.md 第 5 条：不做认知层）。
 */

/** 要几个不同日期才算立住 */
const PROMOTE_DAYS = 3;

export interface Insight {
  id: string;
  content: string;
  status: string;
  witnessDays: string[];
  witnessCount: number;
  lastWitnessedAt: string | null;
  createdAt: string;
}

function today(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

function mapRow(r: {
  id: string;
  content: string;
  status: string;
  witness_days: unknown;
  last_witnessed_at: string | null;
  created_at: string;
}): Insight {
  const days = Array.isArray(r.witness_days) ? (r.witness_days as string[]) : [];
  return {
    id: r.id,
    content: r.content,
    status: r.status,
    witnessDays: days,
    witnessCount: days.length,
    lastWitnessedAt: r.last_witnessed_at,
    createdAt: r.created_at,
  };
}

export async function writeInsight(content: string, sourceIds: string[] = []): Promise<{ id: string; duplicate: boolean }> {
  const text = content.trim();
  if (!text) return { id: '', duplicate: false };

  // 完全一样的就别再写一条了（他们 plan 也是严格字符串去重）
  const same = await one<{ id: string }>(
    `select id::text from insights where content = $1 and status <> 'dropped' limit 1`,
    [text],
  );
  if (same) return { id: same.id, duplicate: true };

  const row = await one<{ id: string }>(
    `insert into insights (content, source_ids) values ($1, $2::jsonb) returning id::text`,
    [text, JSON.stringify(sourceIds)],
  );
  log.info('记下一条"我觉得"', { id: row?.id?.slice(0, 8), chars: text.length });
  return { id: row?.id ?? '', duplicate: false };
}

export async function witnessInsight(id: string, sourceId?: string): Promise<{ ok: boolean; witnessCount: number; established: boolean }> {
  const row = await one<{
    id: string;
    witness_days: unknown;
    source_ids: unknown;
    status: string;
  }>(`select id::text, witness_days, source_ids, status from insights where id = $1::uuid`, [id]);
  if (!row) return { ok: false, witnessCount: 0, established: false };

  const days = new Set(Array.isArray(row.witness_days) ? (row.witness_days as string[]) : []);
  days.add(today());
  const sources = new Set(Array.isArray(row.source_ids) ? (row.source_ids as string[]) : []);
  if (sourceId) sources.add(sourceId);

  const established = days.size >= PROMOTE_DAYS;
  await query(
    `update insights
        set witness_days = $2::jsonb,
            source_ids = $3::jsonb,
            last_witnessed_at = now(),
            status = case when $4 then 'established' else status end,
            updated_at = now()
      where id = $1::uuid`,
    [id, JSON.stringify([...days]), JSON.stringify([...sources]), established],
  );

  if (established && row.status !== 'established') {
    log.info('这条"我觉得"立住了', { id: id.slice(0, 8), days: days.size });
  }
  return { ok: true, witnessCount: days.size, established };
}

export async function listInsights(status?: string): Promise<Insight[]> {
  const rows = await many<{
    id: string;
    content: string;
    status: string;
    witness_days: unknown;
    last_witnessed_at: string | null;
    created_at: string;
  }>(
    `select id::text, content, status, witness_days, last_witnessed_at, created_at
       from insights
      where ($1::text is null or status = $1)
      order by created_at desc limit 100`,
    [status ?? null],
  );
  return rows.map(mapRow);
}

export async function dropInsight(id: string): Promise<void> {
  await query(`update insights set status = 'dropped', updated_at = now() where id = $1::uuid`, [id]);
}
