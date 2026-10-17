import { setDefaultResultOrder } from 'node:dns';

import { config } from './config.js';
import { assertDatabaseReady, closePool } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { probeEmbedding } from './embedding/index.js';
import { startHttpServer } from './http/server.js';
import { startTick } from './jobs/tick.js';
import { loadSettings } from './settings/index.js';
import { log, errFields } from './logger.js';

/**
 * 出站请求优先 IPv6。
 *
 * 踩过的坑：geocoding-api.open-meteo.com 的 **IPv4 地址（202.61.206.6）从这台机器
 * 连不通、会 ETIMEDOUT**，而它的 IPv6 正常。curl 恰好走了 IPv6 所以看着没问题，
 * Node 的 fetch(undici) 选了 IPv4 就一直失败。
 * 先试 IPv6，失败再回落 IPv4（DNS 只给 A 记录时就只有 IPv4，不受影响）。
 */
setDefaultResultOrder('ipv6first');

/**
 * OpenCNS v2 服务入口。
 *
 * 启动顺序刻意保守：
 *   1) 配置已在 config.ts 校验过（缺 key 直接拒绝启动）
 *   2) 数据库连通 + pgvector 存在
 *   3) 迁移检查（幂等；已应用的迁移文件被改动会直接报错）
 *   4) embedding 自检 —— 失败只告警，不阻断（对话仍可用，检索降级）
 *   5) 起时钟、起 HTTP
 *
 * 与旧版最大的区别：**启动不产生业务写副作用**。
 * 旧版启动就跑 decay/archive/dream，每次重启都改数据，且任何一步失败就整个进程起不来。
 */

async function main(): Promise<void> {
  log.info('OpenCNS v2 启动中', {
    env: config.env,
    port: config.port,
    timezone: config.timezone,
    embedding: `${config.embedding.provider}:${config.embedding.model}`,
    chatModel: config.chat.model,
    allowBootWrites: config.allowBootWrites,
  });

  const db = await assertDatabaseReady();
  if (!db.vector) throw new Error('pgvector 扩展不存在，迁移没有跑或跑失败了');
  log.info('数据库就绪', {
    server: db.version.split(' ').slice(0, 2).join(' '),
    pgvector: db.vector,
  });

  const report = await runMigrations();
  log.info('迁移检查完成', { dir: report.dir, applied: report.applied, skipped: report.skipped.length });

  // 运行时设置（模型 / effort / 温度）。必须在起 HTTP 之前加载完，
  // 因为模型客户端在热路径上同步读它。
  await loadSettings();

  if (config.allowBootWrites) {
    log.warn('ALLOW_BOOT_WRITES=true：启动阶段允许写库（v2 默认关闭）');
  }

  try {
    const probe = await probeEmbedding();
    log.info('embedding 自检通过', probe);
  } catch (err) {
    log.error('embedding 自检失败：检索会降级，但对话仍可用', errFields(err));
  }

  const server = startHttpServer();
  const stopTick = await startTick();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('收到退出信号，开始收尾', { signal });
    try {
      stopTick();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await closePool();
      log.info('已干净退出');
      process.exit(0);
    } catch (err) {
      log.error('收尾出错', errFields(err));
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => log.error('未处理的 Promise 拒绝', errFields(reason)));
  process.on('uncaughtException', (err) => {
    log.error('未捕获异常，进程即将退出', errFields(err));
    void shutdown('uncaughtException');
  });
}

main().catch((err) => {
  log.error('启动失败', errFields(err));
  process.exit(1);
});
