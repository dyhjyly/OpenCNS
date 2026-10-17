import { one } from '../db/pool.js';

/**
 * 节拍器 —— 决定"什么时候给他一个机会窗"。
 *
 * 构想原话：
 *   「每隔50分钟给 LLM 一个'机会窗'，既是缓存保活，又是给他自己的空间。
 *     但在 user 说话时，自动静默，在对话结束五分钟后才开始计算50分钟。」
 *
 * 关键纪律（第三铁律）：**欲望永不当第二个闹钟**。
 * 这里只看时间，不看任何欲望数值 —— 欲望只决定"醒来之后想干什么"。
 */

export const WAKE_INTERVAL_MS = 50 * 60_000;
/** 她说完话之后，先安静这么久，再开始算 50 分钟 */
export const QUIET_AFTER_MS = 5 * 60_000;

export interface MetronomeState {
  now: Date;
  lastHerMessageAt: Date | null;
  lastWakeAt: Date | null;
  /** 距她最后一条消息多久 */
  silentMs: number | null;
  /** 距最近一次机会窗多久（与她最后一条消息取较晚者） */
  sinceAnchorMs: number | null;
  due: boolean;
  reason: string;
}

export async function inspectMetronome(): Promise<MetronomeState> {
  const now = new Date();

  const row = await one<{ last_msg: string | null; last_wake: string | null }>(
    `select
       (select max(event_time) from messages where role = 'user') as last_msg,
       (select max(created_at) from wake_log) as last_wake`,
  );

  const lastHerMessageAt = row?.last_msg ? new Date(row.last_msg) : null;
  const lastWakeAt = row?.last_wake ? new Date(row.last_wake) : null;

  const silentMs = lastHerMessageAt ? now.getTime() - lastHerMessageAt.getTime() : null;
  const anchor = Math.max(lastHerMessageAt?.getTime() ?? 0, lastWakeAt?.getTime() ?? 0);
  const sinceAnchorMs = anchor > 0 ? now.getTime() - anchor : null;

  let due = false;
  let reason = '';

  if (silentMs !== null && silentMs < QUIET_AFTER_MS) {
    reason = '她刚说过话，节拍器静默';
  } else if (sinceAnchorMs === null) {
    due = true;
    reason = '还没有任何对话记录，可以开第一个机会窗';
  } else if (sinceAnchorMs < WAKE_INTERVAL_MS) {
    const leftMin = Math.round((WAKE_INTERVAL_MS - sinceAnchorMs) / 60_000);
    reason = `还没到 50 分钟，还差约 ${leftMin} 分钟`;
  } else {
    due = true;
    reason = '机会窗到了';
  }

  return { now, lastHerMessageAt, lastWakeAt, silentMs, sinceAnchorMs, due, reason };
}

/** 记录一次机会窗（无论是否叫醒模型） */
export async function recordWake(input: {
  decision: string | null;
  skippedReason?: string;
  signals: unknown;
  modelCalls: number;
  driveSnapshot: unknown;
}): Promise<number> {
  const row = await one<{ id: string }>(
    `insert into wake_log (scheduled_at, fired_at, signals, decision, skipped_reason, model_calls, drive_snapshot)
     values (now(), now(), $1::jsonb, $2, $3, $4, $5::jsonb)
     returning id`,
    [
      JSON.stringify(input.signals ?? {}),
      input.decision,
      input.skippedReason ?? null,
      input.modelCalls,
      JSON.stringify(input.driveSnapshot ?? {}),
    ],
  );
  return Number(row?.id ?? 0);
}
