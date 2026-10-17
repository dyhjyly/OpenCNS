import { many, one, query } from '../db/pool.js';
import { log, errFields } from '../logger.js';

/**
 * 每日身体数据：步数 / 消耗 / 喝水。
 *
 * **只留近两周**：这类数字越攒越多、价值掉得很快，留着只会让查询变慢、
 * 让上下文变脏。留两周足够看出趋势。
 */

export const KEEP_DAYS = 15;

export interface HealthDay {
  day: string;
  steps: number | null;
  calories: number | null;
  waterMl: number | null;
  activeMin: number | null;
  note: string | null;
}

export async function upsertHealth(input: {
  day?: string;
  steps?: number | null;
  calories?: number | null;
  waterMl?: number | null;
  activeMin?: number | null;
  note?: string | null;
}): Promise<HealthDay | null> {
  const day = input.day ?? new Date().toISOString().slice(0, 10);
  const row = await one<{ day: string }>(
    `insert into health_metrics (day, steps, calories, water_ml, active_min, note)
     values ($1::date, $2, $3, $4, $5, $6)
     on conflict (day) do update set
       steps = coalesce(excluded.steps, health_metrics.steps),
       calories = coalesce(excluded.calories, health_metrics.calories),
       water_ml = coalesce(excluded.water_ml, health_metrics.water_ml),
       active_min = coalesce(excluded.active_min, health_metrics.active_min),
       note = coalesce(excluded.note, health_metrics.note),
       updated_at = now()
     returning day::text`,
    [
      day,
      input.steps ?? null,
      input.calories ?? null,
      input.waterMl ?? null,
      input.activeMin ?? null,
      input.note ?? null,
    ],
  );
  return row ? (await listHealth(15)).find((d) => d.day === row.day) ?? null : null;
}

export async function listHealth(days = 14): Promise<HealthDay[]> {
  const rows = await many<{
    day: string;
    steps: number | null;
    calories: number | null;
    water_ml: number | null;
    active_min: number | null;
    note: string | null;
  }>(
    `select day::text, steps, calories, water_ml, active_min, note
       from health_metrics
      where day > current_date - ($1 || ' days')::interval
      order by day desc`,
    [String(Math.min(KEEP_DAYS, Math.max(1, days)))],
  );
  return rows.map((r) => ({
    day: r.day,
    steps: r.steps,
    calories: r.calories,
    waterMl: r.water_ml,
    activeMin: r.active_min,
    note: r.note,
  }));
}

/** 自动清掉超过 15 天的（每天跑一次） */
export async function pruneHealth(): Promise<number> {
  const rows = await many<{ id: string }>(
    `delete from health_metrics where day < current_date - interval '${KEEP_DAYS} days' returning id`,
  );
  if (rows.length > 0) log.info('清掉了过期的健康数据', { count: rows.length, keepDays: KEEP_DAYS });
  return rows.length;
}

/** 给他看的一段话（几行） */
export async function healthContextLines(days = 7): Promise<string[]> {
  const rows = await listHealth(days);
  if (rows.length === 0) return [];
  const lines: string[] = [];
  for (const r of rows.slice(0, 5)) {
    const bits = [
      r.steps !== null ? `${r.steps} 步` : null,
      r.calories !== null ? `消耗 ${r.calories} 千卡` : null,
      r.waterMl !== null ? `喝水 ${r.waterMl}ml` : null,
      r.activeMin !== null ? `活动 ${r.activeMin} 分钟` : null,
    ].filter(Boolean);
    if (bits.length) lines.push(`· ${r.day.slice(5)}：${bits.join('，')}`);
  }
  if (rows.length >= 2) {
    const steps = rows.map((r) => r.steps).filter((x): x is number => x !== null);
    const water = rows.map((r) => r.waterMl).filter((x): x is number => x !== null);
    const avg: string[] = [];
    if (steps.length) avg.push(`平均 ${Math.round(steps.reduce((a, b) => a + b, 0) / steps.length)} 步`);
    if (water.length) avg.push(`平均喝水 ${Math.round(water.reduce((a, b) => a + b, 0) / water.length)}ml`);
    if (avg.length) lines.push(`· 近 ${rows.length} 天：${avg.join('，')}`);
  }
  return lines;
}
