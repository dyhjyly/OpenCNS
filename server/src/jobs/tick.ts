import os from 'node:os';

import { log, errFields } from '../logger.js';
import { compressOutOfWindow, findSessionsWithPending } from '../memory/compress/pipeline.js';
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
