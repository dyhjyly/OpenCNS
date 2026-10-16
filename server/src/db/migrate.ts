import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pool, closePool, tx } from './pool.js';
import { log, errFields } from '../logger.js';

/**
 * 迁移执行器。
 *
 * 纪律（对应方案「迁移只增不改」）：
 *   - 每个 .sql 文件按文件名排序执行，文件名即版本号（0001_init.sql → 0001_init）。
 *   - 已应用过的文件如果内容变了，直接拒绝执行 —— 说明有人改了历史，必须新增迁移。
 *   - 执行期间持 advisory lock，避免两个进程同时跑。
 *   - 每个文件在单独事务里执行，失败即整体回滚。
 */

const MIGRATION_LOCK_KEY = 'opencns_migrations';

function resolveMigrationsDir(): string {
  const candidates = [
    process.env.MIGRATIONS_DIR,
    fileURLToPath(new URL('../../../migrations', import.meta.url)),
    path.resolve(process.cwd(), 'migrations'),
    path.resolve(process.cwd(), '..', 'migrations'),
  ].filter((v): v is string => typeof v === 'string' && v.length > 0);

  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  throw new Error(`找不到 migrations 目录，尝试过：${candidates.join(' | ')}`);
}

interface AppliedRow {
  version: string;
  checksum: string | null;
}

export interface MigrationReport {
  dir: string;
  applied: string[];
  skipped: string[];
}

export async function runMigrations(dir = resolveMigrationsDir()): Promise<MigrationReport> {
  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock(hashtext($1))', [MIGRATION_LOCK_KEY]);

    await client.query(`
      create table if not exists schema_migrations (
        version    text primary key,
        applied_at timestamptz not null default now(),
        checksum   text
      )
    `);

    const appliedRes = await client.query<AppliedRow>(
      'select version, checksum from schema_migrations',
    );
    const appliedMap = new Map(appliedRes.rows.map((r) => [r.version, r.checksum]));

    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    const applied: string[] = [];
    const skipped: string[] = [];

    for (const file of files) {
      const version = path.basename(file, '.sql');
      const sql = await readFile(path.join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = appliedMap.get(version);

      if (previous !== undefined) {
        if (previous !== null && previous !== checksum) {
          throw new Error(
            `迁移 ${version} 已应用但文件内容被改动（校验和不同）。` +
              `迁移只增不改：请把改动写成新的迁移文件。`,
          );
        }
        skipped.push(version);
        continue;
      }

      log.info('应用迁移', { version, bytes: sql.length });
      await tx(async (c) => {
        await c.query(sql);
        await c.query(
          `insert into schema_migrations (version, checksum) values ($1, $2)
           on conflict (version) do update set checksum = excluded.checksum`,
          [version, checksum],
        );
      });
      applied.push(version);
    }

    return { dir, applied, skipped };
  } finally {
    try {
      await client.query('select pg_advisory_unlock(hashtext($1))', [MIGRATION_LOCK_KEY]);
    } catch {
      /* 连接已断时忽略 */
    }
    client.release();
  }
}

/** 直接执行（npm run migrate） */
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  runMigrations()
    .then((report) => {
      log.info('迁移完成', {
        dir: report.dir,
        applied: report.applied,
        skipped: report.skipped,
      });
    })
    .catch((err) => {
      log.error('迁移失败', errFields(err));
      process.exitCode = 1;
    })
    .finally(() => {
      void closePool();
    });
}
