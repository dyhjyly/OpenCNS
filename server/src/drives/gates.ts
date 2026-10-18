import { one } from '../db/pool.js';

/**
 * 闸门 —— 独立于欲望的一整套限制。
 *
 * 构想原话：「关键约束：满足必须回落。没有回落的欲望系统是永动机，行为会变成轰炸。
 *           所以需要另有整套闸：每日上限、冷却、疲劳闸。」
 *
 * 所以闸门**不参与**欲望数值计算，它只回答一个问题：现在允许主动找她吗？
 * 而且必须能说清楚"被哪一条拦住了"——不能是一个黑箱。
 */

export interface GateLimits {
  dailyMax: number;
  minGapHours: number;
  fatigueMax: number;
  irritationMax: number;
  quietHours: [number, number];
}

export const GATE_LIMITS: GateLimits = {
  /*
   * 每天能主动找她几次。
   *
   * 原来写死 3 次 —— 林遇说太少了：他一天满打满算只被唤醒二十多次，
   * 3 次等于把他「想找你」这件事按掉大半。改成没有上限。
   *
   * 但"没有上限"不等于"随便发"：节拍器仍然 50 分钟才开一次窗，
   * 一次醒来最多发一条，凌晨 1~8 点仍然静默，累了烦了仍然压着。
   */
  dailyMax: Number.POSITIVE_INFINITY,
  /** 两条主动消息之间至少隔多久（小时）。原来 2 小时，现在放宽到 1 小时 */
  minGapHours: 1,
  fatigueMax: 0.75,
  irritationMax: 0.8,
  // 凌晨 1 点到早上 8 点（她那边的时间）不主动打扰
  quietHours: [1, 8],
};

export interface GateStats {
  sentToday: number;
  hoursSinceLastSent: number | null;
  localHour: number;
  fatigue: number;
  irritation: number;
}

export interface GateResult {
  allowed: boolean;
  blockedBy: string[];
  stats: GateStats;
  limits: GateLimits;
}

export async function checkProactiveGates(): Promise<GateResult> {
  const statsRow = await one<{
    sent_today: number;
    hours_since_last: number | null;
    local_hour: number;
  }>(
    `select
       (select count(*) from outbox
         where kind = 'message' and sent_at is not null and sent_at > now() - interval '24 hours')::int as sent_today,
       (select extract(epoch from (now() - max(sent_at))) / 3600
          from outbox where kind = 'message' and sent_at is not null) as hours_since_last,
       extract(hour from (now() at time zone 'Asia/Shanghai'))::int as local_hour`,
  );

  const drives = await one<{ fatigue: number | null; irritation: number | null }>(
    `select
       (select value from drive_state where drive_key = 'fatigue') as fatigue,
       (select value from drive_state where drive_key = 'irritation') as irritation`,
  );

  const stats: GateStats = {
    sentToday: Number(statsRow?.sent_today ?? 0),
    hoursSinceLastSent:
      statsRow?.hours_since_last === null || statsRow?.hours_since_last === undefined
        ? null
        : Number(statsRow.hours_since_last),
    localHour: Number(statsRow?.local_hour ?? 12),
    fatigue: Number(drives?.fatigue ?? 0),
    irritation: Number(drives?.irritation ?? 0),
  };

  const blockedBy: string[] = [];

  if (stats.sentToday >= GATE_LIMITS.dailyMax) {
    blockedBy.push(`今天已经主动找过她 ${stats.sentToday} 次，到上限了`);
  }
  if (stats.hoursSinceLastSent !== null && stats.hoursSinceLastSent < GATE_LIMITS.minGapHours) {
    blockedBy.push('距上一条主动消息还不够久');
  }
  if (stats.fatigue > GATE_LIMITS.fatigueMax) {
    blockedBy.push('累了');
  }
  if (stats.irritation > GATE_LIMITS.irritationMax) {
    blockedBy.push('烦着，不适合开口');
  }
  const [from, to] = GATE_LIMITS.quietHours;
  if (stats.localHour >= from && stats.localHour < to) {
    blockedBy.push('这个点她大概在睡');
  }

  return { allowed: blockedBy.length === 0, blockedBy, stats, limits: GATE_LIMITS };
}
