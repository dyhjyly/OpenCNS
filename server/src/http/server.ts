import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import express, { type NextFunction, type Request, type Response } from 'express';

import { config } from '../config.js';
import { assertDatabaseReady, one } from '../db/pool.js';
import { jobStatus } from '../jobs/runner.js';
import { log, errFields } from '../logger.js';

/**
 * HTTP 边界。
 *
 * M2 只有：健康检查、配置自检、占位 /chat。
 * /chat 的完整链路在 M3/M4 接入（切段 -> 压缩 -> 召回 -> 对话 -> 写回欲望）。
 *
 * 鉴权：如果配置了 API_TOKEN，则 /chat 与 /admin/* 必须带
 *   authorization: Bearer <API_TOKEN>
 * 健康检查不需要（给探活用）。这是单用户服务，但仍然不该让任何网页都能调到它。
 */

/** 请求 id 挂在 req 上；用交叉类型而不是模块增强，避免类型声明出岔子 */
type WithId = Request & { id?: string };

function requireToken(req: Request, res: Response, next: NextFunction) {
  if (!config.apiToken) return next();
  const header = req.get('authorization') ?? '';
  if (header === `Bearer ${config.apiToken}`) return next();
  log.warn('拒绝未授权请求', { path: req.path, ip: req.ip });
  res.status(401).json({ error: 'unauthorized' });
}

export function startHttpServer(): Server {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '25mb' }));

  // 请求 id + 访问日志：出问题时能按 id 把整条链路串起来
  app.use((req, res, next) => {
    const id = randomUUID();
    (req as WithId).id = id;
    res.setHeader('x-request-id', id);
    const started = Date.now();
    res.on('finish', () => {
      log.info('http', {
        requestId: id,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Date.now() - started,
      });
    });
    next();
  });

  // CORS：只在配置了来源时开启（单用户系统，默认不开）
  if (config.corsOrigins.length > 0) {
    app.use((req, res, next) => {
      const origin = req.get('origin');
      if (origin && config.corsOrigins.includes(origin)) {
        res.setHeader('access-control-allow-origin', origin);
        res.setHeader('access-control-allow-headers', 'content-type, authorization');
        res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
      }
      if (req.method === 'OPTIONS') return res.sendStatus(204);
      next();
    });
  }

  app.get('/health', async (_req, res) => {
    try {
      const db = await one<{ n: number }>('select 1 as n');
      const counts = await one<{ memories: number; pending: number; episodes: number }>(
        `select
           (select count(*) from memory_items)::int as memories,
           (select count(*) from outbox where status = 'pending')::int as pending,
           (select count(*) from memory_items where kind = 'episode' and state = 'active')::int as episodes`,
      );
      res.json({
        ok: true,
        db: db?.n === 1,
        uptimeSec: Math.round(process.uptime()),
        memories: counts?.memories ?? null,
        episodes: counts?.episodes ?? null,
        pendingOutbox: counts?.pending ?? null,
        embedding: { provider: config.embedding.provider, model: config.embedding.model, dim: config.embedding.dim },
      });
    } catch (err) {
      res.status(503).json({ ok: false, ...errFields(err) });
    }
  });

  app.get('/admin/config', requireToken, (_req, res) => {
    // 只回显非敏感信息：绝不返回任何 key
    res.json({
      env: config.env,
      timezone: config.timezone,
      chat: { baseUrl: config.chat.baseUrl, model: config.chat.model, hasKey: Boolean(config.chat.apiKey) },
      cognitive: {
        baseUrl: config.cognitive.baseUrl,
        model: config.cognitive.model,
        hasKey: Boolean(config.cognitive.apiKey),
      },
      embedding: {
        provider: config.embedding.provider,
        model: config.embedding.model,
        dim: config.embedding.dim,
        hasKey: Boolean(config.embedding.apiKey),
      },
      push: { pushplus: Boolean(config.push.pushplusToken) },
      apiTokenRequired: Boolean(config.apiToken),
    });
  });

  app.get('/admin/jobs', requireToken, async (_req, res) => {
    res.json({ jobs: await jobStatus() });
  });

  app.get('/admin/db', requireToken, async (_req, res) => {
    try {
      res.json(await assertDatabaseReady());
    } catch (err) {
      res.status(503).json(errFields(err));
    }
  });

  app.post('/chat', requireToken, (_req, res) => {
    /* M3/M4 接入：切段 -> 第一人称压缩 -> 四路召回 -> 主模型 -> 写回欲望 */
    res.status(501).json({
      error: 'not_implemented',
      milestone: 'M3',
      note: '对话链路尚未接线；当前服务只提供数据库与时钟骨架。',
    });
  });

  app.use((req, res) => {
    res.status(404).json({ error: 'not_found', path: req.path });
  });

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    log.error('未捕获的请求错误', { requestId: (req as WithId).id, ...errFields(err) });
    if (!res.headersSent) res.status(500).json({ error: 'internal_error', requestId: (req as WithId).id });
  });

  const server = app.listen(config.port, () => {
    log.info('HTTP 已监听', { port: config.port, apiTokenRequired: Boolean(config.apiToken) });
  });

  return server;
}
