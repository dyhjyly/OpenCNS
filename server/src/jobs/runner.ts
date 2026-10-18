import { many, query } from '../db/pool.js';
import { log, errFields } from '../logger.js';

/**
 * 幂等任务调度。
 *
 * 纪律（对应方案「可观测、可回放、幂等」）：
 *   - 每个任务在 jobs 表里有一行，状态与下次运行时间都在库里，进程重启不丢。
 *   - 抢占用 for update skip locked，重复触发不会跑两遍。
 *   - 认领时就把 run_count 加一、locked_until 推到未来；进程崩了锁会自然过期。
 *   - 失败不吞：写 last_error，并按退避重排，连续失败会体现在 run_count 上。
 */

export interface JobDefinition {
  key: string;
  kind: string;
  /** 两次运行之间的间隔 */
  everyMs: number;
  /** 显式关掉（默认开）。关掉的任务不再登记为 due，也不会被执行 */
  enabled?: boolean;
  run: () => Promise<void>;
}

interface DueJobRow {
  job_key: string;
  kind: string;
  run_count: number;
}

const LOCK_MS = 10 * 60 * 1000;

/** 启动时把任务登记进库（已存在则不动，避免覆盖 next_run_at） */
export async function ensureJobs(defs: JobDefinition[]): Promise<void> {
  for (const d of defs) {
    await query(
      `insert into jobs (job_key, kind, status, next_run_at)
       values ($1, $2, 'idle', now())
       on conflict (job_key) do update set kind = excluded.kind`,
      [d.key, d.kind],
    );
  }
}

/** 认领到期的任务；返回认领到的 key 列表 */
async function claimDue(limit: number): Promise<DueJobRow[]> {
  return many<DueJobRow>(
    `with due as (
       select job_key from jobs
        where (locked_until is null or locked_until < now())
          and (next_run_at is null or next_run_at <= now())
        order by next_run_at nulls first
        limit $1
        for update skip locked
     )
     update jobs j
        set status = 'running',
            locked_until = now() + make_interval(secs => $2),
            last_run_at = now(),
            run_count = j.run_count + 1
       from due
      where j.job_key = due.job_key
      returning j.job_key, j.kind, j.run_count`,
    [limit, LOCK_MS / 1000],
  );
}

async function markDone(key: string, everyMs: number): Promise<void> {
  await query(
    `update jobs
        set status = 'idle',
            last_error = null,
            locked_until = null,
            next_run_at = now() + make_interval(secs => $2)
      where job_key = $1`,
    [key, everyMs / 1000],
  );
}

async function markFailed(key: string, everyMs: number, err: unknown): Promise<void> {
  // 失败后退避到 5 倍间隔，避免坏任务把循环打满
  await query(
    `update jobs
        set status = 'failed',
            last_error = $2,
            locked_until = null,
            next_run_at = now() + make_interval(secs => $3)
      where job_key = $1`,
    [key, String((err as Error)?.message ?? err).slice(0, 500), (everyMs * 5) / 1000],
  );
}

/** 跑一轮：把所有到期任务执行掉。同一进程内串行，避免抢内存（这台机器只有 3.4GB）。 */
export async function runDueJobs(defs: JobDefinition[], limit = 5): Promise<number> {
  const due = await claimDue(limit);
  if (due.length === 0) return 0;

  const byKey = new Map(defs.map((d) => [d.key, d]));

  for (const row of due) {
    const def = byKey.get(row.job_key);
    if (!def) {
      // 库里有、代码里没有：标记失败，提示清理
      await markFailed(row.job_key, 60_000, new Error('代码里没有注册这个任务'));
      continue;
    }
    if (def.enabled === false) {
      // 关掉的任务：把下次运行时间推远，不要每分钟空转
      await markDone(row.job_key, 24 * 60 * 60_000);
      continue;
    }

    const started = Date.now();
    try {
      await def.run();
      await markDone(row.job_key, def.everyMs);
      log.info('任务完成', { job: row.job_key, ms: Date.now() - started, run: row.run_count });
    } catch (err) {
      await markFailed(row.job_key, def.everyMs, err);
      log.error('任务失败', { job: row.job_key, ms: Date.now() - started, ...errFields(err) });
    }
  }

  return due.length;
}

export async function jobStatus(): Promise<
  { job_key: string; status: string; next_run_at: string | null; last_error: string | null; run_count: number }[]
> {
  return many(
    `select job_key, status, next_run_at, last_error, run_count
       from jobs order by job_key`,
  );
}
