import pg from 'pg';

import { config } from '../config.js';
import { log, errFields } from '../logger.js';

/**
 * 单一连接池。所有 SQL 都走这里，方便统一埋点与超时。
 *
 * 注意：辅助函数的泛型刻意**不加** `T extends pg.QueryResultRow` 约束。
 * 那个约束要求类型带字符串索引签名，而 interface 不会隐式获得索引签名，
 * 于是 `many<SomeInterface>()` 会在编译期报错。这里改为在内部做一次断言。
 */

export const pool = new pg.Pool({
  connectionString: config.database.url,
  max: config.database.poolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  application_name: 'opencns',
});

pool.on('error', (err) => {
  log.error('数据库连接池空闲连接出错', errFields(err));
});

export async function query<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  const started = Date.now();
  try {
    const res = await pool.query(text, params as never[]);
    return res as unknown as pg.QueryResult<T>;
  } finally {
    const ms = Date.now() - started;
    if (ms > 500) log.warn('慢查询', { ms, sql: text.slice(0, 120) });
  }
}

export async function many<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await query<T>(text, params);
  return res.rows;
}

export async function one<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const res = await query<T>(text, params);
  return res.rows[0] ?? null;
}

/** 事务：回调抛错则回滚 */
export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (err) {
    try {
      await client.query('rollback');
    } catch (rollbackErr) {
      log.error('回滚失败', errFields(rollbackErr));
    }
    throw err;
  } finally {
    client.release();
  }
}

/** 启动自检：连得上、pgvector 在不在 */
export async function assertDatabaseReady(): Promise<{ version: string; vector: string | null }> {
  const v = await one<{ version: string }>('select version() as version');
  const ext = await one<{ extversion: string }>(
    "select extversion from pg_extension where extname = 'vector'",
  );
  return { version: v?.version ?? 'unknown', vector: ext?.extversion ?? null };
}

export async function closePool(): Promise<void> {
  await pool.end();
}
