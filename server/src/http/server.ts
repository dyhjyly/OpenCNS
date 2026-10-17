import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import express, { type NextFunction, type Request, type Response } from 'express';

import { config } from '../config.js';
import { assertDatabaseReady, one, query } from '../db/pool.js';
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

  app.post('/admin/compress', requireToken, async (req, res) => {
    /**
     * 手动触发压缩，便于验收与补跑：
     *   { "sessionId": "...", "keepRecent": 20 }  只压这一个会话
     *   { "pendingOnly": true }                   扫一遍所有有待压缩内容的会话
     */
    try {
      const body = (req.body ?? {}) as { sessionId?: string; keepRecent?: number; pendingOnly?: boolean };
      if (body.sessionId) {
        const { compressOutOfWindow, compressWholeSession } = await import('../memory/compress/pipeline.js');
        const result =
          body.keepRecent === 0
            ? await compressWholeSession(body.sessionId)
            : await compressOutOfWindow(body.sessionId, body.keepRecent);
        return res.json({ ok: true, results: [result] });
      }
      const { compressOutOfWindow: run, findSessionsWithPending } = await import('../memory/compress/pipeline.js');
      const pending = await findSessionsWithPending(5);
      const results = [];
      for (const s of pending) results.push(await run(s.session_id));
      return res.json({ ok: true, pending: pending.length, results });
    } catch (err) {
      log.error('手动压缩失败', errFields(err));
      return res.status(500).json({ ok: false, ...errFields(err) });
    }
  });

  app.post('/admin/maintenance', requireToken, async (req, res) => {
    /**
     * 手动跑一次养护任务，便于验收与补跑：
     *   { "job": "decay" | "dedupe" | "noise" | "timeline" | "all" }
     *
     * 注意：手动执行也要**把任务的下次运行时间往后推**，否则常驻时钟会以为它还没跑过，
     * 立刻再跑一遍（同一件事跑两次，去重这种任务尤其不希望）。
     */
    try {
      const job = String((req.body as { job?: string })?.job ?? 'all');
      const out: Record<string, unknown> = {};
      const bump = async (key: string) => {
        await query(`update jobs set next_run_at = now() + interval '1 hour' where job_key = $1`, [key]);
      };

      if (job === 'decay' || job === 'all') {
        const { runDecay } = await import('../memory/maintenance/decay.js');
        out.decay = await runDecay();
        await bump('decay');
      }
      if (job === 'noise' || job === 'all') {
        const { runNoiseScan } = await import('../memory/maintenance/dedupe.js');
        out.noise = await runNoiseScan();
        await bump('noise_scan');
      }
      if (job === 'dedupe' || job === 'all') {
        const { runDedupe } = await import('../memory/maintenance/dedupe.js');
        out.dedupe = await runDedupe();
        await bump('dedupe');
      }
      if (job === 'timeline' || job === 'all') {
        const { runTimelineBuild } = await import('../memory/timeline/build.js');
        const { invalidateTimelineCache } = await import('../memory/timeline/render.js');
        await runTimelineBuild();
        invalidateTimelineCache();
        await bump('timeline_build');
        out.timeline = 'built';
      }
      return res.json({ ok: true, job, out });
    } catch (err) {
      log.error('养护任务手动执行失败', errFields(err));
      return res.status(500).json({ ok: false, ...errFields(err) });
    }
  });

  app.get('/admin/drives', requireToken, async (_req, res) => {
    try {
      const { getFullSnapshot, buildDriveHints } = await import('../drives/render.js');
      const { checkProactiveGates } = await import('../drives/gates.js');
      const hints = await buildDriveHints();
      res.json({
        drives: await getFullSnapshot(),
        gates: await checkProactiveGates(),
        // 实际注入模型的那几行（应当**不含任何数字**）
        injectedHints: hints,
        hintsContainDigits: /\d/.test(hints.join(' ')),
      });
    } catch (err) {
      res.status(500).json(errFields(err));
    }
  });

  app.post('/admin/drives', requireToken, async (req, res) => {
    /**
     * 手动推一下欲望的时间侧（验收用）：
     *   { "action": "tick" }   跑一次缓动 + 沉默信号 + 脉冲检查
     *   { "action": "set", "key": "missing", "value": 0.8, "reason": "手工设置" }
     */
    try {
      const body = (req.body ?? {}) as { action?: string; key?: string; value?: number; reason?: string };
      if (body.action === 'tick' || !body.action) {
        const { runDriveTick } = await import('../drives/tick.js');
        return res.json({ ok: true, tick: await runDriveTick() });
      }
      if (body.action === 'set') {
        if (!body.key || typeof body.value !== 'number') {
          return res.status(400).json({ error: 'key_and_value_required' });
        }
        // 直接设定，不走单轮限幅（限幅是"每一轮对话"的纪律；手工设置不是一轮对话，
        // 否则要把它推到 0.9 得调用六次，验收根本没法做）
        const { setDriveValue } = await import('../drives/state.js');
        const applied = await setDriveValue(body.key, body.value, body.reason ?? '手工设置（验收用）');
        if (!applied) return res.status(404).json({ error: 'unknown_drive', key: body.key });
        return res.json({ ok: true, applied });
      }
      return res.status(400).json({ error: 'unknown_action' });
    } catch (err) {
      res.status(500).json(errFields(err));
    }
  });

  app.get('/admin/timeline', requireToken, async (_req, res) => {
    try {
      const { getTimelineLines } = await import('../memory/timeline/render.js');
      res.json({ lines: await getTimelineLines() });
    } catch (err) {
      res.status(500).json(errFields(err));
    }
  });

  app.post('/chat', requireToken, async (req, res) => {
    try {
      const body = (req.body ?? {}) as { message?: string; sessionId?: string; endSession?: boolean };
      if (!body.message || !body.message.trim()) {
        return res.status(400).json({ error: 'message_required' });
      }
      const { handleChat } = await import('../chat/index.js');
      const result = await handleChat({
        message: body.message,
        sessionId: body.sessionId,
        endSession: body.endSession,
      });
      return res.json(result);
    } catch (err) {
      log.error('对话失败', { requestId: (req as WithId).id, ...errFields(err) });
      return res.status(500).json({ error: 'chat_failed', requestId: (req as WithId).id });
    }
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
