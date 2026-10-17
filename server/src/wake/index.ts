import { log } from '../logger.js';
import { listDrives } from '../drives/state.js';
import { bandOf, DRIVE_BY_KEY } from '../drives/definitions.js';
import { checkProactiveGates } from '../drives/gates.js';
import { decideAndAct, type WakeOutcome, type WakeSignals } from './decide.js';
import { inspectMetronome, recordWake, type MetronomeState } from './metronome.js';
import { buildRoomPack, saveRoomPack } from './room.js';

/**
 * 唤醒回路。
 *
 *   节拍器开窗 → 三信号 ──(全低)──> 零成本跳过（不调用模型，只记账）
 *                    └──(有信号)──> 醒来房间 → 六选一 → 执行 → 写经历 → 欲望回落
 *
 * 三个设计取舍：
 *   1) **零成本跳过**：什么信号都没有时绝不调用模型。核心是不制造"为了醒而醒"的表演。
 *   2) **房间不是任务清单**：素材里禁止祈使句（room.ts 里做替换并留痕）。
 *   3) **经历闭环**：醒来做的事写成第一人称经历 —— 下次醒来看到（意识连续）、
 *      她能看到（她知道我独处时在干嘛）、进记忆库（以后能当回忆）。
 */

export interface WakeCycleResult {
  skipped: boolean;
  skipReason?: string;
  metronome: MetronomeState;
  signals?: WakeSignals;
  outcome?: WakeOutcome;
  wakeLogId?: number;
}

/** 三信号：想不想她 / 有没有想做的事 / 该不该休息 */
async function computeSignals(): Promise<WakeSignals> {
  const rows = await listDrives();
  const val = (key: string) => rows.find((r) => r.drive_key === key)?.value ?? 0;
  const reason = (key: string) =>
    rows.find((r) => r.drive_key === key)?.last_reason_text ?? DRIVE_BY_KEY.get(key)?.signal ?? '';

  const wantHer = Math.max(val('missing'), val('intimacy'));
  const wantDo = Math.max(
    val('urge_to_make'),
    val('curiosity'),
    val('urge_to_speak'),
    val('concern'),
    val('anticipation'),
    val('wanderlust'),
  );
  const shouldRest = val('fatigue');

  const detail = rows
    .filter((r) => r.value >= 0.3)
    .sort((a, b) => b.value - a.value)
    .slice(0, 5)
    .map((r) => ({ key: DRIVE_BY_KEY.get(r.drive_key)?.label ?? r.drive_key, band: bandOf(r.value), reason: reason(r.drive_key) }));

  return { wantHer, wantDo, shouldRest, detail };
}

/** 三信号全低 -> 零成本跳过。这是整个唤醒机制里最重要的一道省电闸。 */
const SIGNAL_FLOOR = 0.35;

export async function runWakeCycle(opts: { force?: boolean } = {}): Promise<WakeCycleResult> {
  const metronome = await inspectMetronome();

  if (!opts.force && !metronome.due) {
    return { skipped: true, skipReason: metronome.reason, metronome };
  }

  const signals = await computeSignals();

  // ---- 零成本跳过：不调用模型 ----
  if (!opts.force && signals.wantHer < SIGNAL_FLOOR && signals.wantDo < SIGNAL_FLOOR) {
    const wakeLogId = await recordWake({
      decision: null,
      skippedReason: '三信号都没起来，零成本跳过',
      signals,
      modelCalls: 0,
      driveSnapshot: signals.detail,
    });
    log.info('零成本跳过（没有叫醒模型）', {
      wantHer: Number(signals.wantHer.toFixed(2)),
      wantDo: Number(signals.wantDo.toFixed(2)),
      shouldRest: Number(signals.shouldRest.toFixed(2)),
    });
    return { skipped: true, skipReason: '三信号都没起来', metronome, signals, wakeLogId };
  }

  const gate = await checkProactiveGates();
  const pack = await buildRoomPack();
  const outcome = await decideAndAct({ pack, signals, gate, actorName: '' });

  const wakeLogId = await recordWake({
    decision: outcome.decision,
    signals,
    modelCalls: outcome.modelCalls,
    driveSnapshot: { detail: signals.detail, driveHints: [] },
  });
  await saveRoomPack(wakeLogId, pack, pack.rendered);

  // 把这次醒来和它写下的经历绑起来，醒来房间才解释得清"这一条是谁留下的"
  if (outcome.experienceId) {
    const { query } = await import('../db/pool.js');
    await query(
      `update memory_items set provenance = provenance || jsonb_build_object('wake_id', $2::int)
        where id = $1`,
      [outcome.experienceId, wakeLogId],
    ).catch(() => undefined);
  }

  return { skipped: false, metronome, signals, outcome, wakeLogId };
}
