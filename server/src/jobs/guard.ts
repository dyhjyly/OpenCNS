import { one, query } from '../db/pool.js';

/**
 * 定时任务的"今天做过没有" —— 避免重启后同一件事一天跑好几次。
 * 用 settings 表存，键名带日期。
 */

export async function hourNow(): Promise<number> {
  const row = await one<{ h: number }>(
    `select extract(hour from (now() at time zone 'Asia/Shanghai'))::int as h`,
  );
  return row?.h ?? 0;
}

export async function ranToday(key: string): Promise<boolean> {
  const k = `job.${key}.${new Date().toISOString().slice(0, 10)}`;
  const row = await one<{ value: unknown }>(`select value from settings where key = $1`, [k]);
  return Boolean(row);
}

export async function markRan(key: string, payload: unknown): Promise<void> {
  const k = `job.${key}.${new Date().toISOString().slice(0, 10)}`;
  await query(
    `insert into settings (key, value) values ($1, $2::jsonb)
     on conflict (key) do update set value = excluded.value`,
    [k, JSON.stringify(payload ?? { ok: true })],
  );
}
