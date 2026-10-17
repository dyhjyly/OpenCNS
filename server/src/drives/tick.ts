import { many, one, query } from '../db/pool.js';
import { log, errFields } from '../logger.js';
import { DRIFT_PER_MINUTE } from './definitions.js';
import { applyDeltas, driftTowardBaseline, type DeltaApplied } from './state.js';

/**
 * 时间侧的欲望变化 —— 只由**真实信号**驱动，不用随机数。
 *
 * 三件事：
 *   1) 向 baseline 缓动回归（没有信号时慢慢回到静止水位）
 *   2) 沉默本身是信号：她越久不出现，"想你""想说"越涨
 *   3) 过夜脉冲：到期一次性触发，错过不补发
 */

export interface DriveTickResult {
  elapsedMinutes: number;
  drifted: number;
  hoursSinceHer: number | null;
  silenceDeltas: DeltaApplied[];
  pulsesFired: number;
  pulsesExpired: number;
}

/** 距离上次动过欲望状态过了多久（分钟） */
async function elapsedMinutes(): Promise<number> {
  const row = await one<{ minutes: number | null }>(
    `select extract(epoch from (now() - min(updated_at))) / 60 as minutes from drive_state`,
  );
  const m = Number(row?.minutes ?? 0);
  return Number.isFinite(m) ? Math.max(1, Math.min(24 * 60, m)) : 1;
}

/** 她多久没出现了 */
async function hoursSinceHerMessage(): Promise<number | null> {
  const row = await one<{ hours: number | null }>(
    `select extract(epoch from (now() - max(event_time))) / 3600 as hours
       from messages where role = 'user'`,
  );
  const h = row?.hours === null || row?.hours === undefined ? null : Number(row.hours);
  return h !== null && Number.isFinite(h) ? h : null;
}

export async function runDriveTick(): Promise<DriveTickResult> {
  const started = Date.now();
  const elapsed = await elapsedMinutes();
  const hours = await hoursSinceHerMessage();

  // 1) 缓动回归
  const drifted = await driftTowardBaseline(elapsed, DRIFT_PER_MINUTE);

  // 2) 沉默信号（她超过 2 小时没出现才开始涨）
  const silenceDeltas: DeltaApplied[] = [];
  if (hours !== null && hours > 2) {
    const overtime = hours - 2;
    silenceDeltas.push(
      ...(await applyDeltas([
        {
          key: 'missing',
          delta: Math.min(0.12, 0.02 * overtime),
          reasonCode: 'silence',
          reasonText: `她已经${coarseDuration(hours)}没出现了`,
          source: 'silence',
          evidence: { hoursSinceHer: Number(hours.toFixed(2)) },
        },
        {
          key: 'urge_to_speak',
          delta: Math.min(0.1, 0.015 * overtime),
          reasonCode: 'silence',
          reasonText: '攒了一些没说的话',
          source: 'silence',
          evidence: { hoursSinceHer: Number(hours.toFixed(2)) },
        },
      ])),
    );
  }

  // 3) 清醒时长带来的疲惫（很慢：约 60 小时从 0.1 涨到 0.7）
  if (hours !== null) {
    await applyDeltas([
      {
        key: 'fatigue',
        delta: Math.min(0.03, 0.0006 * elapsed),
        reasonCode: 'wakefulness',
        reasonText: '一直醒着',
        source: 'decay',
      },
    ]);
  }

  // 4) 过夜脉冲
  let pulsesFired = 0;
  let pulsesExpired = 0;
  try {
    const due = await many<{ id: string; drive_key: string; source: string; due_at: string }>(
      `select id, drive_key, source, due_at from drive_pulses
        where fired_at is null and due_at <= now()
        order by due_at limit 5`,
    );
    for (const p of due) {
      const lateHours = (Date.now() - new Date(p.due_at).getTime()) / 3_600_000;
      if (lateHours > 6) {
        // 错过不补发：标记掉，不再触发
        await query(`update drive_pulses set fired_at = now(), source = source || '（错过已作废）' where id = $1`, [
          p.id,
        ]);
        pulsesExpired++;
        log.info('过夜脉冲已过期（错过不补发）', { id: p.id, lateHours: Number(lateHours.toFixed(1)) });
        continue;
      }
      await query(`update drive_pulses set fired_at = now() where id = $1 and fired_at is null`, [p.id]);
      await applyDeltas([
        {
          key: p.drive_key,
          delta: 0.10,
          reasonCode: 'intimacy_pulse',
          reasonText: `过夜余波：${p.source}`,
          source: 'intimacy_pulse',
          evidence: { pulseId: p.id, dueAt: p.due_at },
        },
      ]);
      pulsesFired++;
      log.info('过夜脉冲触发（一次性）', { id: p.id, drive: p.drive_key, source: p.source });
    }
  } catch (err) {
    log.error('脉冲检查失败', errFields(err));
  }

  const result: DriveTickResult = {
    elapsedMinutes: Number(elapsed.toFixed(1)),
    drifted,
    hoursSinceHer: hours === null ? null : Number(hours.toFixed(2)),
    silenceDeltas,
    pulsesFired,
    pulsesExpired,
  };

  if (drifted > 0 || silenceDeltas.length > 0 || pulsesFired > 0 || pulsesExpired > 0) {
    log.info('欲望时间侧更新', { ...result, ms: Date.now() - started });
  }
  return result;
}

/** 粗粒度时长：只给"场景类别"，不给数值 */
export function coarseDuration(hours: number): string {
  if (hours < 1) return '不到一小时';
  if (hours < 3) return '几个钟头';
  if (hours < 8) return '小半天';
  if (hours < 20) return '大半天';
  if (hours < 36) return '一整天';
  if (hours < 72) return '快两天';
  return '好一阵子';
}
