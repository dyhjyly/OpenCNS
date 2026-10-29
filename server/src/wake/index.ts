import { log } from '../logger.js';
import { listDrives } from '../drives/state.js';
import { bandOf, DRIVE_BY_KEY } from '../drives/definitions.js';
import { checkProactiveGates } from '../drives/gates.js';
import type { WakeOutcome, WakeSignals } from './decide.js';
import { inspectMetronome, recordWake, type MetronomeState } from './metronome.js';

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
      forced: opts.force ?? false,
    });
    log.info('零成本跳过（没有叫醒模型）', {
      wantHer: Number(signals.wantHer.toFixed(2)),
      wantDo: Number(signals.wantDo.toFixed(2)),
      shouldRest: Number(signals.shouldRest.toFixed(2)),
    });
    return { skipped: true, skipReason: '三信号都没起来', metronome, signals, wakeLogId };
  }

  const gate = await checkProactiveGates();

  /*
   * 醒来 = 一次不用她开口的对话。
   *
   * 以前是"拼一个醒来房间再让他六选一"——那等于把他放进一个只看得到素材、
   * 看不到你们刚说过什么的小房间，他自然认不出自己说过的话。
   * 现在走和聊天完全相同的上下文（身份提示词 + 7 天对话），
   * 只把最后一句换成"她这会儿没说话"。
   */
  const { runWakeTurn } = await import('./turn.js');
  const turn = await runWakeTurn(signals);

  const outcome: WakeOutcome = {
    decision: turn.decision === 'post' ? 'social' : turn.decision,
    actions: turn.actions,
    reason: turn.decision === 'stay_quiet' ? '他自己决定继续安静' : '他自己开口了',
    message: turn.message ?? undefined,
    momentIds: turn.momentId ? [turn.momentId] : [],
    patted: false,
    commented: 0,
    modelCalls: turn.modelCalls,
    gateBlocked: gate.allowed ? [] : gate.blockedBy,
    outboxQueued: false,
    satisfaction: [],
  };

  const wakeLogId = await recordWake({
    decision: outcome.decision,
    actions: outcome.actions,
    signals,
    modelCalls: outcome.modelCalls,
    driveSnapshot: {
      detail: signals.detail,
      driveHints: [],
      gate: gate.allowed ? 'open' : `blocked:${gate.blockedBy.join(',')}`,
    },
    forced: opts.force ?? false,
  });

  return { skipped: false, metronome, signals, outcome, wakeLogId };
}
