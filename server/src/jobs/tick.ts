import os from 'node:os';

import { log, errFields } from '../logger.js';
import { getEmbeddingProvider } from '../embedding/index.js';
import { checkProactiveGates } from '../drives/gates.js';
import { runDriveTick } from '../drives/tick.js';
import { runWakeCycle } from '../wake/index.js';
import { runDecay } from '../memory/maintenance/decay.js';
import { runDedupe, runNoiseScan } from '../memory/maintenance/dedupe.js';
import { compressOutOfWindow, findSessionsWithPending } from '../memory/compress/pipeline.js';
import { runTimelineBuild } from '../memory/timeline/build.js';
import { invalidateTimelineCache } from '../memory/timeline/render.js';
import { dispatchPending } from '../push/index.js';
import { ensureJobs, runDueJobs, type JobDefinition } from './runner.js';

/**
 * 常驻时钟。
 *
 * 现状（M2）：只跑心跳与投递投递两个任务。
 * 后续里程碑会往这里挂：
 *   M3 compress_queue  滑出窗口的对话段 -> 第一人称情景记忆
 *   M5 timeline_build  周摘要 / 月档案 / 奠基事件
 *   M5 dedupe + graph_edges  每周查重与连边
 *   M5 decay           按"多久没被想起"衰减、沉底归档
 *   M6 drive_tick      十二维欲望的时间缓动与回落
 *   M7 metronome       节拍器（她沉默 5 分钟后开始计 50 分钟）
 *   M7 intimacy_pulse  20~44h 内的一次性余波
 *   M8 surprise_reveal / note_expire
 *
 * 铁律：任务只在本进程串行执行，绝不并发 —— 这台机器只有 3.4GB 内存。
 */

const TICK_INTERVAL_MS = 30_000;

function buildJobs(): JobDefinition[] {
  return [
    {
      // 保活 bge-m3：它闲置一会儿就会被 Ollama 卸载，下一次召回要重新载入
      // （实测冷启动 8~14 秒，直接把一轮对话拖到 40 秒以上）。
      // 每 10 分钟喂它一个短句，成本可以忽略，换来召回的稳定延迟。
      key: 'embed_keepalive',
      kind: 'observability',
      everyMs: 10 * 60_000,
      async run() {
        const started = Date.now();
        const provider = getEmbeddingProvider();
        const [vec] = await provider.embed(['保活']);
        log.info('embedding 保活', {
          provider: provider.name,
          dim: vec?.length ?? 0,
          ms: Date.now() - started,
        });
      },
    },
    {
      key: 'heartbeat',
      kind: 'observability',
      everyMs: 5 * 60_000,
      async run() {
        const total = os.totalmem() / 1024 / 1024;
        const free = os.freemem() / 1024 / 1024;
        const rss = process.memoryUsage().rss / 1024 / 1024;
        log.info('心跳', {
          rssMB: Math.round(rss),
          freeMB: Math.round(free),
          totalMB: Math.round(total),
          usedPct: Math.round(((total - free) / total) * 100),
          loadavg: os.loadavg().map((n) => Number(n.toFixed(2))),
          uptimeH: Math.round(process.uptime() / 3600),
        });
      },
    },
    {
      key: 'push_dispatch',
      kind: 'delivery',
      everyMs: 20_000,
      async run() {
        const r = await dispatchPending(10);
        if (r.sent || r.failed) log.info('投递队列', r);
      },
    },
    {
      // M3：滑出窗口的对话 -> 第一人称情景记忆
      key: 'compress_queue',
      kind: 'memory',
      everyMs: 5 * 60_000,
      async run() {
        const sessions = await findSessionsWithPending(2);
        if (sessions.length === 0) return;
        log.info('发现待压缩会话', { sessions: sessions.map((s) => `${s.session_id.slice(0, 8)}+${s.pending}`) });
        for (const s of sessions) {
          const r = await compressOutOfWindow(s.session_id);
          log.info('会话压缩结果', r);
        }
      },
    },
    {
      // M5：衰减。按"多久没被想起"重算鲜活度，沉底归档
      key: 'decay',
      kind: 'maintenance',
      everyMs: 6 * 60 * 60_000, // 每 6 小时（纯函数，重算幂等，跑勤一点没坏处）
      async run() {
        await runDecay();
      },
    },
    {
      // M5：时间树。周回顾 / 月档案 / 奠基事件
      key: 'timeline_build',
      kind: 'memory',
      everyMs: 6 * 60 * 60_000,
      async run() {
        await runTimelineBuild();
        invalidateTimelineCache(); // 新摘要要立刻生效，不能等缓存过期
      },
    },
    {
      // M5：去重。向量找候选、LLM 做判定，合并保留信息量大的那条
      key: 'dedupe',
      kind: 'maintenance',
      everyMs: 7 * 24 * 60 * 60_000, // 每周
      async run() {
        await runDedupe();
      },
    },
    {
      // M5：降噪。只剪确凿的模板/测试文本，模糊的只登记不动手
      key: 'noise_scan',
      kind: 'maintenance',
      everyMs: 24 * 60 * 60_000,
      async run() {
        await runNoiseScan();
      },
    },
    {
      // M6：欲望的时间侧。缓动回归 + 沉默信号 + 过夜脉冲
      key: 'drive_tick',
      kind: 'drives',
      everyMs: 5 * 60_000,
      async run() {
        await runDriveTick();
      },
    },
    {
      // M6：闸门自检。只记录"现在允不允许主动找她"，不在这里发起任何行为
      key: 'gate_check',
      kind: 'drives',
      everyMs: 30 * 60_000,
      async run() {
        const gate = await checkProactiveGates();
        log.info('闸门自检', { allowed: gate.allowed, blockedBy: gate.blockedBy, ...gate.stats });
      },
    },
    {
      // M7：节拍器。每分钟看一次机会窗到没到；
      // 到窗也未必叫醒模型 —— 三信号全低就零成本跳过（不制造"为了醒而醒"的表演）
      key: 'wake_cycle',
      kind: 'wake',
      everyMs: 60_000,
      async run() {
        const result = await runWakeCycle();
        if (!result.skipped) {
          log.info('唤醒了一次', {
            decision: result.outcome?.decision,
            reason: result.outcome?.reason,
            outboxQueued: result.outcome?.outboxQueued,
          });
        }
      },
    },
  ];
}

let timer: NodeJS.Timeout | null = null;
let running = false;

export async function startTick(): Promise<() => void> {
  const jobs = buildJobs();
  await ensureJobs(jobs);
  log.info('时钟已启动', { tickMs: TICK_INTERVAL_MS, jobs: jobs.map((j) => j.key) });

  const loop = async () => {
    if (running) {
      log.warn('上一轮 tick 还没跑完，跳过本轮');
      return;
    }
    running = true;
    try {
      await runDueJobs(jobs);
    } catch (err) {
      log.error('tick 异常', errFields(err));
    } finally {
      running = false;
    }
  };

  timer = setInterval(() => void loop(), TICK_INTERVAL_MS);
  timer.unref?.();
  void loop(); // 立刻跑一轮，让登记的任务有机会马上执行

  return () => {
    if (timer) clearInterval(timer);
    timer = null;
    log.info('时钟已停止');
  };
}
