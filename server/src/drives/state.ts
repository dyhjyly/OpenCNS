import { many, query, tx } from '../db/pool.js';
import { log } from '../logger.js';
import { DRIVE_BY_KEY, MAX_DELTA_PER_TURN, type DriveLayer } from './definitions.js';

/**
 * 欲望状态的读写。
 *
 * 一条铁律：**涨落全部来自真实信号**。所以每一次变化都必须在 drive_events 里
 * 留下"为什么"，任何一个数值都能回答"它是怎么变成这样的"。
 */

export interface DriveRow {
  drive_key: string;
  layer: DriveLayer;
  value: number;
  baseline: number;
  trend: number;
  last_reason_code: string | null;
  last_reason_text: string | null;
  updated_at: string;
}

export type DeltaSource = 'chat' | 'silence' | 'action' | 'intimacy_pulse' | 'decay' | 'manual';

export interface DeltaInput {
  key: string;
  delta: number;
  reasonCode: string;
  reasonText?: string;
  source: DeltaSource;
  evidence?: unknown;
}

export interface DeltaApplied {
  key: string;
  from: number;
  to: number;
  delta: number;
}

export async function listDrives(): Promise<DriveRow[]> {
  return many<DriveRow>(
    `select drive_key, layer, value, baseline, trend, last_reason_code, last_reason_text, updated_at
       from drive_state order by layer, drive_key`,
  );
}

export async function getDrive(key: string): Promise<DriveRow | null> {
  const rows = await many<DriveRow>(
    `select drive_key, layer, value, baseline, trend, last_reason_code, last_reason_text, updated_at
       from drive_state where drive_key = $1`,
    [key],
  );
  return rows[0] ?? null;
}

/** 记录一次涨落：限幅 -> 写状态 -> 写来由 */
export async function applyDeltas(inputs: DeltaInput[]): Promise<DeltaApplied[]> {
  const applied: DeltaApplied[] = [];

  await tx(async (client) => {
    for (const input of inputs) {
      const def = DRIVE_BY_KEY.get(input.key);
      if (!def) {
        log.warn('未知的欲望维度，忽略', { key: input.key });
        continue;
      }

      const { rows } = await client.query(
        'select value from drive_state where drive_key = $1 for update',
        [input.key],
      );
      if (rows.length === 0) continue;

      const from = Number(rows[0].value);
      // 限幅：单轮最多动这么多，避免过冲成"无端的浓度表演"
      const clamped = Math.max(-MAX_DELTA_PER_TURN, Math.min(MAX_DELTA_PER_TURN, input.delta));
      const to = Math.max(0, Math.min(1, from + clamped));
      const actual = Number((to - from).toFixed(4));
      if (actual === 0) continue;

      await client.query(
        `update drive_state
            set value = $2, trend = $3, last_reason_code = $4, last_reason_text = $5, updated_at = now()
          where drive_key = $1`,
        [input.key, to, actual, input.reasonCode, input.reasonText ?? null],
      );

      await client.query(
        `insert into drive_events (drive_key, delta, value_after, reason_code, reason_text, source, evidence)
         values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [
          input.key,
          actual,
          to,
          input.reasonCode,
          input.reasonText ?? null,
          input.source,
          JSON.stringify(input.evidence ?? {}),
        ],
      );

      applied.push({ key: input.key, from, to, delta: actual });

      // 亲密过线 -> 埋一颗"过夜脉冲"（20~44 小时内一次性触发，错过不补发）
      if (input.key === 'intimacy' && from < 0.7 && to >= 0.7) {
        await scheduleIntimacyPulse(client, input.reasonText ?? '亲密过线');
      }
    }
  });

  if (applied.length > 0) {
    log.info('欲望涨落', {
      changes: applied.map((a) => `${a.key} ${a.from.toFixed(2)}->${a.to.toFixed(2)}`),
    });
  }
  return applied;
}

/** 埋脉冲。有未触发的脉冲时不再埋第二颗，避免攒出好几发。 */
async function scheduleIntimacyPulse(
  client: { query: (text: string, params?: unknown[]) => Promise<unknown> },
  source: string,
): Promise<void> {
  // 20~44 小时后的一个随机点
  const hours = 20 + Math.random() * 24;
  await client.query(
    `insert into drive_pulses (drive_key, due_at, source)
     select 'intimacy', now() + make_interval(secs => $1), $2
      where not exists (
        select 1 from drive_pulses where drive_key = 'intimacy' and fired_at is null
      )`,
    [Math.round(hours * 3600), source],
  );
  log.info('埋下一次过夜脉冲', { afterHours: Number(hours.toFixed(1)), source });
}

/** 时间缓动：向 baseline 回归。分钟数由调用方算好传入。 */
export async function driftTowardBaseline(elapsedMinutes: number, ratePerMinute: number): Promise<number> {
  const rows = await many<{ drive_key: string; value: number; baseline: number }>(
    'select drive_key, value, baseline from drive_state',
  );
  let changed = 0;
  for (const r of rows) {
    const factor = Math.min(0.5, ratePerMinute * elapsedMinutes);
    const next = r.value + (r.baseline - r.value) * factor;
    if (Math.abs(next - r.value) < 0.002) continue;
    await query(
      `update drive_state set value = $2, trend = $3, updated_at = now(), last_reason_code = 'drift'
        where drive_key = $1`,
      [r.drive_key, next, Number((next - r.value).toFixed(4))],
    );
    changed++;
  }
  return changed;
}
