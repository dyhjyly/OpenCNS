import pg from 'pg';
import { config } from '../config.js';
import { log, errFields } from '../logger.js';

/**
 * 单一连接池。所有 SQL 都走这里，方便统一埋点与超时。
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

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  const started = Date.now();
  try {
    return await pool.query<T>(text, params as never[]);
  } finally {
    const ms = Date.now() - started;
    if (ms > 500) log.warn('慢查询', { ms, sql: text.slice(0, 120) });
  }
}

export async function many<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await query<T>(text, params);
  return res.rows;
}

export async function one<T extends pg.QueryResultRow = pg.QueryResultRow>(
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

/** 启动自检：连得上、版本对、pgvector 在 */
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
