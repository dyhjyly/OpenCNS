import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import express, { type NextFunction, type Request, type Response } from 'express';

import { config } from '../config.js';
import { assertDatabaseReady, many, one, query } from '../db/pool.js';
import { jobStatus } from '../jobs/runner.js';
import { login, logout, check, status } from '../auth/session.js';
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

  /*
   * 登录态。这几个**不需要 requireToken** —— 它们本身就是拿身份的地方。
   *
   * 从 HTTP Basic 换成 cookie 的原因：装到桌面（PWA standalone）之后，
   * Chrome 经常不再带 Basic 凭据，整站 401，表现就是"前端连不上后端"。
   * 现在由 nginx 的 auth_request 调 /auth/check 判断，cookie 一直有效。
   */
  app.post('/auth/login', (req, res) => login(req, res));
  app.post('/auth/logout', (req, res) => logout(req, res));
  app.get('/auth/check', (req, res) => check(req, res));
  app.get('/auth/status', (req, res) => status(req, res));

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

  /*
   * 上下文预览：把这一轮真正会发给模型的内容原样吐出来。
   *
   * 不调模型、不写库。她想看"他到底收到了什么"，就不用再猜了。
   * 用法：GET /admin/context?q=随便一句话
   */
  app.get('/admin/context', requireToken, async (req, res) => {
    try {
      const { previewContext } = await import('../chat/index.js');
      const q = String(req.query.q ?? '在吗');
      const out = await previewContext(q, req.query.sessionId ? String(req.query.sessionId) : undefined);
      return res.json({ ok: true, ...out });
    } catch (err) {
      log.error('上下文预览失败', errFields(err));
      return res.status(500).json(errFields(err));
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

  app.get('/admin/settings', requireToken, async (_req, res) => {
    try {
      const { snapshot, EDITABLE_KEYS } = await import('../settings/index.js');
      return res.json({ ok: true, editable: EDITABLE_KEYS, ...(await snapshot()) });
    } catch (err) {
      return res.status(500).json(errFields(err));
    }
  });

  app.get('/home', requireToken, async (req, res) => {
    try {
      const { getHomeSummary, getWeather } = await import('../home/index.js');
      const lat = req.query.lat ? Number(req.query.lat) : undefined;
      const lon = req.query.lon ? Number(req.query.lon) : undefined;
      const city = typeof req.query.city === 'string' ? req.query.city : undefined;
      const fresh = req.query.fresh === '1' || req.query.fresh === 'true';

      const [summary, weather] = await Promise.all([
        getHomeSummary(),
        getWeather({
          lat: Number.isFinite(lat) ? lat : undefined,
          lon: Number.isFinite(lon) ? lon : undefined,
          city,
          fresh,
        }),
      ]);

      res.json({ ok: true, ...summary, weather });
    } catch (err) {
      log.error('主页汇总失败', errFields(err));
      res.status(500).json(errFields(err));
    }
  });

  app.get('/weather', requireToken, async (req, res) => {
    try {
      const { getWeather } = await import('../home/index.js');
      const lat = req.query.lat ? Number(req.query.lat) : undefined;
      const lon = req.query.lon ? Number(req.query.lon) : undefined;
      const city = typeof req.query.city === 'string' ? req.query.city : undefined;
      res.json(await getWeather({ lat: Number.isFinite(lat) ? lat : undefined, lon: Number.isFinite(lon) ? lon : undefined, city }));
    } catch (err) {
      res.status(500).json(errFields(err));
    }
  });

  app.post('/admin/settings', requireToken, async (_req, res) => {
    // 有意只接受 PUT：GET 读、PUT 改，避免 POST 被误用成"整份覆盖"
    return res.status(405).json({ error: 'use_put' });
  });

  app.put('/admin/settings', requireToken, async (req, res) => {
    /**
     * 改模型 / effort / 温度 / 输出上限，立刻生效（不用重启）。
     * 这是给前端准备的入口：
     *   { "llm.chat_model": "deepseek-v4-pro", "llm.chat_effort": "max" }
     */
    try {
      const { setSetting, EDITABLE_KEYS } = await import('../settings/index.js');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const editable = new Set<string>(EDITABLE_KEYS);

      const accepted: Record<string, unknown> = {};
      const rejected: string[] = [];
      for (const [key, value] of Object.entries(body)) {
        if (!editable.has(key)) {
          rejected.push(key);
          continue;
        }
        accepted[key] = value;
      }

      // 模型名先校验再写库：否则一个错字会被写进设置，下一轮对话直接崩。
      const modelKeys = ['llm.chat_model', 'llm.cognitive_model'] as const;
      const wanted = modelKeys
        .map((k) => accepted[k])
        .filter((m): m is string => typeof m === 'string');
      if (wanted.length > 0) {
        const { listModels } = await import('../llm/client.js');
        const known = await listModels().catch(() => null);
        const bad = known ? wanted.filter((m) => !known.includes(m)) : [];
        if (bad.length > 0) {
          return res.status(400).json({ error: 'unknown_model', bad, available: known });
        }
      }

      const applied: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(accepted)) {
        await setSetting(key, value);
        applied[key] = value;
      }

      return res.json({ ok: true, applied, rejected });
    } catch (err) {
      log.error('更新设置失败', errFields(err));
      return res.status(500).json(errFields(err));
    }
  });

  app.post('/admin/wake', requireToken, async (req, res) => {
    /**
     * 手动触发一次唤醒回路，便于验收与补跑：
     *   { "force": true }  忽略节拍器与"零成本跳过"，强制走完整回路
     */
    try {
      const force = Boolean((req.body as { force?: boolean })?.force);
      const { runWakeCycle } = await import('../wake/index.js');
      const result = await runWakeCycle({ force });
      return res.json({ ok: true, result });
    } catch (err) {
      log.error('手动唤醒失败', errFields(err));
      return res.status(500).json({ ok: false, ...errFields(err) });
    }
  });

  app.get('/admin/wake', requireToken, async (_req, res) => {
    try {
      const { inspectMetronome } = await import('../wake/metronome.js');
      const { many } = await import('../db/pool.js');
      const recent = await many(
        `select id, created_at, decision, skipped_reason, model_calls
           from wake_log order by created_at desc limit 10`,
      );
      const counts = await many<{ decision: string | null; n: number }>(
        `select decision, count(*)::int as n from wake_log group by 1 order by 2 desc`,
      );
      return res.json({ metronome: await inspectMetronome(), recent, counts });
    } catch (err) {
      return res.status(500).json(errFields(err));
    }
  });

  app.get('/mind', requireToken, async (_req, res) => {
    try {
      const { getMindPanel } = await import('../drives/panel.js');
      return res.json({ ok: true, ...(await getMindPanel()) });
    } catch (err) {
      log.error('读心境失败', errFields(err));
      return res.status(500).json(errFields(err));
    }
  });

  /* ─── 日历 / 经期 ─── */
  app.get('/calendar', requireToken, async (req, res) => {
    try {
      const { calendarMonth } = await import('../calendar/index.js');
      const now = new Date();
      const year = Number(req.query.year ?? now.getFullYear());
      const month = Number(req.query.month ?? now.getMonth() + 1);
      return res.json({ ok: true, year, month, ...(await calendarMonth(year, month)) });
    } catch (err) {
      return res.status(500).json(errFields(err));
    }
  });

  app.post('/calendar/day', requireToken, async (req, res) => {
    try {
      const { upsertDailyState } = await import('../calendar/index.js');
      const b = (req.body ?? {}) as { day?: string; mood?: string; energy?: number; note?: string };
      if (!b.day) return res.status(400).json({ error: 'day_required' });
      await upsertDailyState({ day: b.day, mood: b.mood ?? null, energy: b.energy ?? null, note: b.note ?? null });
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json(errFields(err));
    }
  });

  app.delete('/calendar/day/:day', requireToken, async (req, res) => {
    try {
      const { deleteDailyState } = await import('../calendar/index.js');
      await deleteDailyState(String(req.params.day));
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json(errFields(err));
    }
  });

  app.get('/calendar/cycle', requireToken, async (_req, res) => {
    try {
      const { cycleStatus, listCycleEntries } = await import('../calendar/index.js');
      return res.json({ ok: true, status: await cycleStatus(), entries: await listCycleEntries(24) });
    } catch (err) {
      return res.status(500).json(errFields(err));
    }
  });

  app.post('/calendar/cycle', requireToken, async (req, res) => {
    try {
      const { addCycleEntry } = await import('../calendar/index.js');
      const b = (req.body ?? {}) as { kind?: string; day?: string; note?: string };
      const kind = b.kind === 'end' ? 'end' : 'start';
      const day = b.day ?? new Date().toISOString().slice(0, 10);
      await addCycleEntry(kind, day, b.note ?? null);
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json(errFields(err));
    }
  });

  app.delete('/calendar/cycle/:kind/:day', requireToken, async (req, res) => {
    try {
      const { deleteCycleEntry } = await import('../calendar/index.js');
      const kind = String(req.params.kind) === 'end' ? 'end' : 'start';
      await deleteCycleEntry(kind, String(req.params.day));
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json(errFields(err));
    }
  });

  /* ─── 身体数据（只留近两周）─── */
  // 注意路径不能叫 /health：上面已经有一个服务健康检查，会抢先匹配
  app.get('/body', requireToken, async (req, res) => {
    try {
      const { listHealth, KEEP_DAYS } = await import('../health/metrics.js');
      const days = Math.min(KEEP_DAYS, Math.max(1, Number(req.query.days ?? KEEP_DAYS)));
      return res.json({ ok: true, keepDays: KEEP_DAYS, days: await listHealth(days) });
    } catch (err) {
      return res.status(500).json(errFields(err));
    }
  });

  app.post('/body', requireToken, async (req, res) => {
    try {
      const { upsertHealth } = await import('../health/metrics.js');
      const b = (req.body ?? {}) as Record<string, unknown>;
      const num = (v: unknown) => (v === undefined || v === null || v === '' ? null : Number(v));
      const row = await upsertHealth({
        day: typeof b.day === 'string' ? b.day : undefined,
        steps: num(b.steps),
        calories: num(b.calories),
        waterMl: num(b.waterMl),
        activeMin: num(b.activeMin),
        note: typeof b.note === 'string' ? b.note : null,
      });
      return res.json({ ok: true, row });
    } catch (err) {
      return res.status(500).json(errFields(err));
    }
  });

  // 手动记睡眠（她要的主路径：自己记，他想看再查）
  app.post('/sleep', requireToken, async (req, res) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const night = typeof b.night === 'string' && b.night ? b.night : new Date().toISOString().slice(0, 10);
      const num = (v: unknown) => (v === undefined || v === null || v === '' ? null : Math.round(Number(v)));
      const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
      await query(
        `insert into sleep_records
           (night, bedtime, wake_time, total_minutes, awake_count,
            deep_minutes, light_minutes, rem_minutes, awake_minutes, source, note)
         values ($1::date,$2,$3,$4,$5,$6,$7,$8,$9,'manual',$10)
         on conflict (night) do update set
           bedtime = excluded.bedtime, wake_time = excluded.wake_time,
           total_minutes = excluded.total_minutes, awake_count = excluded.awake_count,
           deep_minutes = excluded.deep_minutes, light_minutes = excluded.light_minutes,
           rem_minutes = excluded.rem_minutes, awake_minutes = excluded.awake_minutes,
           note = excluded.note, source = 'manual', updated_at = now()`,
        [
          night,
          str(b.bedtime),
          str(b.wakeTime),
          num(b.totalMinutes),
          num(b.awakeCount),
          num(b.deepMinutes),
          num(b.lightMinutes),
          num(b.remMinutes),
          num(b.awakeMinutes),
          str(b.note),
        ],
      );
      const { listSleep } = await import('../health/sleep.js');
      return res.json({ ok: true, record: (await listSleep(30)).find((r) => r.night === night) ?? null });
    } catch (err) {
      log.error('手动记睡眠失败', errFields(err));
      return res.status(500).json(errFields(err));
    }
  });

  app.post('/sleep/analyze', requireToken, async (req, res) => {
    try {
      const uploadId = String((req.body as { uploadId?: string })?.uploadId ?? '');
      if (!uploadId) return res.status(400).json({ error: 'uploadId_required' });
      const { analyzeScreenshot } = await import('../health/sleep.js');
      const out = await analyzeScreenshot(uploadId);
      if (!out.record) return res.status(422).json({ ok: false, error: out.error, raw: out.raw });
      return res.json({ ok: true, record: out.record });
    } catch (err) {
      log.error('睡眠识别失败', errFields(err));
      return res.status(500).json(errFields(err));
    }
  });

  app.get('/sleep', requireToken, async (req, res) => {
    try {
      const days = Math.min(400, Math.max(1, Number(req.query.days ?? 30)));
      const { listSleep, sleepStats } = await import('../health/sleep.js');
      return res.json({ ok: true, records: await listSleep(days), stats: await sleepStats(days) });
    } catch (err) {
      return res.status(500).json(errFields(err));
    }
  });

  app.patch('/sleep/:night', requireToken, async (req, res) => {
    try {
      const { patchSleep } = await import('../health/sleep.js');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const patch: Record<string, unknown> = {};
      for (const k of ['bedtime', 'wakeTime', 'totalMinutes', 'awakeCount', 'deepMinutes', 'lightMinutes', 'remMinutes', 'awakeMinutes', 'note']) {
        if (body[k] !== undefined) patch[k] = body[k];
      }
      const ok = await patchSleep(String(req.params.night), patch as never);
      return res.json({ ok });
    } catch (err) {
      return res.status(500).json(errFields(err));
    }
  });

  app.get('/moments', requireToken, async (req, res) => {
    try {
      const { listMoments } = await import('../social/moments.js');
      const limit = Math.min(60, Math.max(1, Number(req.query.limit ?? 30)));
      return res.json({ ok: true, moments: await listMoments(limit) });
    } catch (err) {
      log.error('读朋友圈失败', errFields(err));
      return res.status(500).json(errFields(err));
    }
  });

  app.post('/moments', requireToken, async (req, res) => {
    try {
      const { createMoment } = await import('../social/moments.js');
      const body = (req.body ?? {}) as {
        content?: string;
        author?: 'self' | 'human';
        images?: { id: string; name: string; mime: string }[];
        mood?: string;
      };
      const moment = await createMoment({
        author: body.author === 'self' ? 'self' : 'human',
        content: String(body.content ?? ''),
        images: body.images,
        mood: body.mood ?? null,
      });
      return res.json({ ok: true, moment });
    } catch (err) {
      return res.status(400).json({ error: 'create_failed', message: String((err as Error)?.message ?? err) });
    }
  });

  app.post('/moments/:id/like', requireToken, async (req, res) => {
    try {
      const { toggleLike } = await import('../social/moments.js');
      const who = (req.body as { author?: string })?.author === 'self' ? 'self' : 'human';
      return res.json({ ok: true, ...(await toggleLike(String(req.params.id), who)) });
    } catch (err) {
      return res.status(500).json(errFields(err));
    }
  });

  app.post('/moments/:id/comments', requireToken, async (req, res) => {
    try {
      const { addComment } = await import('../social/moments.js');
      const body = (req.body ?? {}) as { content?: string; author?: 'self' | 'human' };
      await addComment(String(req.params.id), body.author === 'self' ? 'self' : 'human', String(body.content ?? ''));
      return res.json({ ok: true });
    } catch (err) {
      return res.status(400).json({ error: 'comment_failed', message: String((err as Error)?.message ?? err) });
    }
  });

  app.delete('/moments/:id', requireToken, async (req, res) => {
    try {
      const { deleteMoment } = await import('../social/moments.js');
      await deleteMoment(String(req.params.id));
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json(errFields(err));
    }
  });

  app.get('/wake/room', requireToken, async (_req, res) => {
    try {
      const { getWakeRoom } = await import('../wake/room-view.js');
      return res.json({ ok: true, ...(await getWakeRoom(20)) });
    } catch (err) {
      log.error('读醒来房间失败', errFields(err));
      return res.status(500).json(errFields(err));
    }
  });

  app.post('/pat', requireToken, async (req, res) => {
    try {
      const { pat } = await import('../social/moments.js');
      const body = (req.body ?? {}) as { from?: 'self' | 'human'; suffix?: string; sessionId?: string };
      await pat({
        from: body.from === 'self' ? 'self' : 'human',
        to: body.from === 'self' ? 'human' : 'self',
        suffix: body.suffix ?? null,
        sessionId: body.sessionId ?? null,
      });
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json(errFields(err));
    }
  });

  app.get('/pat', requireToken, async (_req, res) => {
    try {
      const { recentPats } = await import('../social/moments.js');
      return res.json({ ok: true, pats: await recentPats(120) });
    } catch (err) {
      return res.status(500).json(errFields(err));
    }
  });

  /* ─── 记忆整理 ─── */
  app.get('/memory/review', requireToken, async (req, res) => {
    try {
      const { listForReview, reviewStats } = await import('../memory/review.js');
      const filter = ['no_time', 'third_person', 'all'].includes(String(req.query.filter))
        ? (String(req.query.filter) as 'no_time' | 'third_person' | 'all')
        : 'no_time';
      const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20)));
      const offset = Math.max(0, Number(req.query.offset ?? 0));
      return res.json({
        ok: true,
        filter,
        items: await listForReview({ filter, limit, offset }),
        stats: await reviewStats(),
      });
    } catch (err) {
      log.error('读记忆整理失败', errFields(err));
      return res.status(500).json(errFields(err));
    }
  });

  app.post('/memory/review/:id/time', requireToken, async (req, res) => {
    try {
      const { setMemoryTime } = await import('../memory/review.js');
      const day = String((req.body as { eventTime?: string })?.eventTime ?? '');
      const ok = await setMemoryTime(String(req.params.id), day);
      return res.json({ ok });
    } catch (err) {
      return res.status(500).json(errFields(err));
    }
  });

  app.delete('/memory/review/:id', requireToken, async (req, res) => {
    try {
      const { deleteMemory } = await import('../memory/review.js');
      return res.json({ ok: await deleteMemory(String(req.params.id)) });
    } catch (err) {
      return res.status(500).json(errFields(err));
    }
  });

  app.post('/memory/review/bulk-delete', requireToken, async (req, res) => {
    try {
      const { deleteBySource } = await import('../memory/review.js');
      const source = String((req.body as { source?: string })?.source ?? '');
      if (!source) return res.status(400).json({ error: 'source_required' });
      const n = await deleteBySource(source);
      return res.json({ ok: true, deleted: n });
    } catch (err) {
      return res.status(500).json(errFields(err));
    }
  });

  /* ─── MCP：她手动连，他才有工具 ─── */
  app.get('/mcp', requireToken, async (_req, res) => {
    try {
      const { listServers } = await import('../mcp/index.js');
      return res.json({ ok: true, servers: await listServers() });
    } catch (err) {
      return res.status(500).json(errFields(err));
    }
  });

  app.post('/mcp', requireToken, async (req, res) => {
    try {
      const { addServer } = await import('../mcp/index.js');
      const b = (req.body ?? {}) as { name?: string; url?: string; token?: string; headers?: Record<string, string> };
      const name = String(b.name ?? '').trim();
      const url = String(b.url ?? '').trim();
      if (!name || !url) return res.status(400).json({ error: 'name_and_url_required' });
      const headers: Record<string, string> = { ...(b.headers ?? {}) };
      if (b.token && b.token.trim()) headers.authorization = `Bearer ${b.token.trim()}`;
      const s = await addServer({ name, url, headers });
      return res.json({ ok: true, server: s });
    } catch (err) {
      return res.status(500).json(errFields(err));
    }
  });

  app.delete('/mcp/:id', requireToken, async (req, res) => {
    try {
      const { removeServer } = await import('../mcp/index.js');
      await removeServer(String(req.params.id));
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json(errFields(err));
    }
  });

  app.post('/mcp/:id/connect', requireToken, async (req, res) => {
    try {
      const { connect } = await import('../mcp/index.js');
      const out = await connect(String(req.params.id));
      return res.status(out.ok ? 200 : 400).json(out);
    } catch (err) {
      log.error('MCP 连接异常', errFields(err));
      return res.status(500).json(errFields(err));
    }
  });

  app.post('/mcp/:id/disconnect', requireToken, async (req, res) => {
    try {
      const { disconnect } = await import('../mcp/index.js');
      await disconnect(String(req.params.id));
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json(errFields(err));
    }
  });

  app.post('/mcp/:id/call', requireToken, async (req, res) => {
    try {
      const { callTool } = await import('../mcp/index.js');
      const b = (req.body ?? {}) as { tool?: string; args?: Record<string, unknown> };
      if (!b.tool) return res.status(400).json({ error: 'tool_required' });
      const text = await callTool(String(req.params.id), b.tool, b.args ?? {});
      return res.json({ ok: true, text });
    } catch (err) {
      return res.status(500).json(errFields(err));
    }
  });

  /* ─── 记忆审核（他写的先给她看）─── */
  app.get('/memory/drafts', requireToken, async (req, res) => {
    try {
      const { listDrafts, pendingCount } = await import('../memory/drafts.js');
      const status = ['pending', 'approved', 'rejected', 'all'].includes(String(req.query.status))
        ? String(req.query.status)
        : 'pending';
      return res.json({
        ok: true,
        status,
        pending: await pendingCount(),
        drafts: await listDrafts(status, Math.min(100, Number(req.query.limit ?? 50))),
      });
    } catch (err) {
      log.error('读记忆待审失败', errFields(err));
      return res.status(500).json(errFields(err));
    }
  });

  app.post('/memory/drafts/:id/approve', requireToken, async (req, res) => {
    try {
      const { approveDraft } = await import('../memory/drafts.js');
      const b = (req.body ?? {}) as { content?: string; eventTime?: string; kind?: string; importance?: number };
      const out = await approveDraft(String(req.params.id), b);
      return res.status(out.ok ? 200 : 400).json(out);
    } catch (err) {
      return res.status(500).json(errFields(err));
    }
  });

  app.post('/memory/drafts/:id/reject', requireToken, async (req, res) => {
    try {
      const { rejectDraft } = await import('../memory/drafts.js');
      const note = (req.body as { note?: string })?.note;
      return res.json({ ok: await rejectDraft(String(req.params.id), note) });
    } catch (err) {
      return res.status(500).json(errFields(err));
    }
  });

  app.get('/memory/starmap', requireToken, async (_req, res) => {
    try {
      const { getStarMap } = await import('../memory/starmap.js');
      const map = await getStarMap();
      res.setHeader('cache-control', 'private, max-age=60');
      return res.json({ ok: true, ...map });
    } catch (err) {
      log.error('星图接口失败', errFields(err));
      return res.status(500).json(errFields(err));
    }
  });

  app.get('/memory/item/:id', requireToken, async (req, res) => {
    try {
      const { getMemoryItem } = await import('../memory/starmap.js');
      const item = await getMemoryItem(String(req.params.id));
      if (!item) return res.status(404).json({ error: 'not_found' });
      return res.json({ ok: true, item });
    } catch (err) {
      return res.status(500).json(errFields(err));
    }
  });

  app.get('/memory/search', requireToken, async (req, res) => {
    try {
      const { searchMemories } = await import('../memory/starmap.js');
      const q = typeof req.query.q === 'string' ? req.query.q : undefined;
      const kind = typeof req.query.kind === 'string' ? req.query.kind : undefined;
      const from = typeof req.query.from === 'string' ? req.query.from : undefined;
      const to = typeof req.query.to === 'string' ? req.query.to : undefined;
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      return res.json({ ok: true, ...(await searchMemories({ q, kind, from, to, limit })) });
    } catch (err) {
      return res.status(500).json(errFields(err));
    }
  });

  app.get('/admin/usage', requireToken, async (_req, res) => {
    try {
      const { getUsageSummary } = await import('../llm/usage.js');
      return res.json({ ok: true, ...(await getUsageSummary()) });
    } catch (err) {
      log.error('用量统计失败', errFields(err));
      return res.status(500).json(errFields(err));
    }
  });

  app.get('/admin/status', requireToken, async (_req, res) => {
    try {
      const { getUsageSummary: _u } = await import('../llm/usage.js');
      const db = await assertDatabaseReady();
      const { getEmbeddingProvider } = await import('../embedding/index.js');
      const provider = getEmbeddingProvider();
      const gate = await (await import('../drives/gates.js')).checkProactiveGates();
      const jobs = await many<{ job_key: string; status: string; run_count: number; last_error: string | null }>(
        `select job_key, status, run_count, left(coalesce(last_error,''),80) as last_error from jobs order by job_key`,
      );
      const mem = await one<{ n: number }>(`select count(*)::int as n from memory_items`);
      return res.json({
        ok: true,
        db: { ok: true, version: db.version, vector: db.vector },
        embedding: { provider: provider.name, dim: provider.dim },
        gates: gate,
        jobs,
        memories: mem?.n ?? 0,
        uptimeSec: Math.round(process.uptime()),
      });
    } catch (err) {
      return res.status(500).json({ ok: false, ...errFields(err) });
    }
  });

  app.post('/upload', requireToken, async (req, res) => {
    try {
      const body = (req.body ?? {}) as { name?: string; mime?: string; dataBase64?: string };
      if (!body.dataBase64) return res.status(400).json({ error: 'dataBase64_required' });
      const { saveUpload } = await import('../chat/uploads.js');
      const saved = await saveUpload({
        name: body.name ?? 'file',
        mime: body.mime ?? 'application/octet-stream',
        dataBase64: body.dataBase64,
      });
      return res.json({ ok: true, ...saved, url: `/v2/api/upload/${saved.id}` });
    } catch (err) {
      log.error('上传失败', errFields(err));
      return res.status(400).json({ error: 'upload_failed', message: String((err as Error)?.message ?? err) });
    }
  });

  app.get('/upload/:id', requireToken, async (req, res) => {
    try {
      const { readUpload, mimeOfExt } = await import('../chat/uploads.js');
      const file = await readUpload(String(req.params.id));
      if (!file) return res.status(404).json({ error: 'not_found' });
      res.setHeader('content-type', mimeOfExt(file.ext));
      res.setHeader('cache-control', 'private, max-age=86400');
      return res.send(file.buf);
    } catch (err) {
      return res.status(500).json(errFields(err));
    }
  });

  app.get('/chat/history', requireToken, async (req, res) => {
    try {
      const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
      if (!sessionId) return res.status(400).json({ error: 'sessionId_required' });
      const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 60)));
      const { getChatHistory } = await import('../chat/index.js');
      return res.json({ ok: true, ...(await getChatHistory(sessionId, limit)) });
    } catch (err) {
      log.error('读聊天历史失败', errFields(err));
      return res.status(500).json(errFields(err));
    }
  });

  app.post('/chat', requireToken, async (req, res) => {
    try {
      const body = (req.body ?? {}) as {
        message?: string;
        sessionId?: string;
        endSession?: boolean;
        attachments?: import('../chat/index.js').ChatAttachment[];
      };
      if (!body.message || !body.message.trim()) {
        return res.status(400).json({ error: 'message_required' });
      }
      const { handleChat } = await import('../chat/index.js');
      const result = await handleChat({
        message: body.message,
        sessionId: body.sessionId,
        endSession: body.endSession,
        attachments: body.attachments,
      });
      return res.json(result);
    } catch (err) {
      log.error('对话失败', { requestId: (req as WithId).id, ...errFields(err) });
      return res.status(500).json({ error: 'chat_failed', requestId: (req as WithId).id });
    }
  });

  app.post('/chat/stream', requireToken, async (req, res) => {
    /**
     * SSE 流式对话：逐字推送，感知延迟从几十秒降到一两秒。
     * 事件：meta（会话/召回信息）→ delta（逐字）→ done（完整结果）| error
     */
    try {
      const body = (req.body ?? {}) as {
        message?: string;
        sessionId?: string;
        endSession?: boolean;
        attachments?: import('../chat/index.js').ChatAttachment[];
      };
      if (!body.message || !body.message.trim()) {
        return res.status(400).json({ error: 'message_required' });
      }
      const { handleChatStream } = await import('../chat/index.js');
      await handleChatStream(
        {
          message: body.message,
          sessionId: body.sessionId,
          endSession: body.endSession,
          attachments: body.attachments,
        },
        res,
      );
    } catch (err) {
      log.error('流式对话失败', { requestId: (req as WithId).id, ...errFields(err) });
      if (!res.headersSent) {
        return res.status(500).json({ error: 'chat_stream_failed', requestId: (req as WithId).id });
      }
      res.end();
    }
  });

  app.use((req, res) => {
    res.status(404).json({ error: 'not_found', path: req.path });
  });

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    log.error('未捕获的请求错误', { requestId: (req as WithId).id, ...errFields(err) });
    if (!res.headersSent) res.status(500).json({ error: 'internal_error', requestId: (req as WithId).id });
  });

  const server = app.listen(config.port, config.host, () => {
    log.info('HTTP 已监听', {
      host: config.host,
      port: config.port,
      apiTokenRequired: Boolean(config.apiToken),
    });
  });

  return server;
}
