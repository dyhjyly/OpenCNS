import { many, one, query } from '../db/pool.js';
import { log, errFields } from '../logger.js';

/**
 * 日历 + 经期。
 *
 * 设计前提（林遇定的）：**这些平时她自己记就好，他想看的时候再问系统要。**
 * 所以这里只做存取与推算，不主动往对话里灌。
 *
 * 经期：她自己点"开始 / 结束"，系统据此推算周期长度与下次大概时间。
 * 推算是**估算**，措辞上必须说"大概"，不能当事实讲。
 */

export interface DailyState {
  day: string;
  mood: string | null;
  energy: number | null;
  note: string | null;
}

export interface CycleEntry {
  id: string;
  kind: 'start' | 'end';
  day: string;
  note: string | null;
}

export interface CycleStatus {
  /** 最近一次开始 */
  lastStart: string | null;
  /** 还有没有未结束的那次 */
  ongoing: boolean;
  /** 根据历史推算的平均周期天数 */
  avgLengthDays: number | null;
  /** 推算的下次开始（大约） */
  nextEstimate: string | null;
  /** 距下次还有几天（负数是已过） */
  daysUntilNext: number | null;
  samples: number;
}

/* ─────────── 每日状态 ─────────── */

export async function upsertDailyState(input: {
  day: string;
  mood?: string | null;
  energy?: number | null;
  note?: string | null;
}): Promise<void> {
  await query(
    `insert into daily_states (day, mood, energy, note)
     values ($1::date, $2, $3, $4)
     on conflict (day) do update set
       mood = coalesce(excluded.mood, daily_states.mood),
       energy = coalesce(excluded.energy, daily_states.energy),
       note = coalesce(excluded.note, daily_states.note),
       updated_at = now()`,
    [input.day, input.mood ?? null, input.energy ?? null, input.note ?? null],
  );
}

export async function listDailyStates(days = 60): Promise<DailyState[]> {
  const rows = await many<{ day: string; mood: string | null; energy: number | null; note: string | null }>(
    `select day::text, mood, energy, note from daily_states
      where day > current_date - ($1 || ' days')::interval
      order by day desc`,
    [String(days)],
  );
  return rows;
}

export async function deleteDailyState(day: string): Promise<void> {
  await query(`delete from daily_states where day = $1::date`, [day]);
}

/* ─────────── 经期 ─────────── */

export async function addCycleEntry(kind: 'start' | 'end', day: string, note?: string | null): Promise<void> {
  await query(
    `insert into cycle_entries (kind, day, note) values ($1, $2::date, $3)
     on conflict (kind, day) do update set note = coalesce(excluded.note, cycle_entries.note)`,
    [kind, day, note ?? null],
  );
}

export async function deleteCycleEntry(kind: 'start' | 'end', day: string): Promise<void> {
  await query(`delete from cycle_entries where kind = $1 and day = $2::date`, [kind, day]);
}

export async function listCycleEntries(limit = 30): Promise<CycleEntry[]> {
  return many<CycleEntry>(
    `select id::text, kind, day::text, note from cycle_entries order by day desc limit $1`,
    [limit],
  );
}

export async function cycleStatus(): Promise<CycleStatus> {
  const starts = await many<{ day: string }>(
    `select day::text from cycle_entries where kind = 'start' order by day desc limit 12`,
  );
  const lastEnd = await one<{ day: string }>(
    `select day::text from cycle_entries where kind = 'end' order by day desc limit 1`,
  );

  const lastStart = starts[0]?.day ?? null;
  const ongoing = Boolean(lastStart && (!lastEnd || lastEnd.day < lastStart));

  // 相邻两次开始的间隔 = 周期长度
  const gaps: number[] = [];
  for (let i = 0; i + 1 < starts.length; i++) {
    const a = new Date(starts[i]!.day).getTime();
    const b = new Date(starts[i + 1]!.day).getTime();
    const d = Math.round((a - b) / 86400_000);
    if (d >= 15 && d <= 60) gaps.push(d); // 明显不合理的不要
  }
  const avgLengthDays = gaps.length ? Math.round(gaps.reduce((x, y) => x + y, 0) / gaps.length) : null;

  let nextEstimate: string | null = null;
  let daysUntilNext: number | null = null;
  if (lastStart && avgLengthDays) {
    const d = new Date(lastStart);
    d.setDate(d.getDate() + avgLengthDays);
    nextEstimate = d.toISOString().slice(0, 10);
    daysUntilNext = Math.round((d.getTime() - Date.now()) / 86400_000);
  }

  return { lastStart, ongoing, avgLengthDays, nextEstimate, daysUntilNext, samples: gaps.length };
}

/** 给他看的一段话（他想问的时候才调） */
export async function cycleContextLines(): Promise<string[]> {
  const s = await cycleStatus();
  if (!s.lastStart) return [];
  const lines = [`· 上次开始：${s.lastStart}`];
  if (s.ongoing) lines.push('· 这次还没点结束');
  if (s.avgLengthDays) lines.push(`· 她的周期大约是 ${s.avgLengthDays} 天（根据 ${s.samples} 次记录推的，是估算）`);
  if (s.nextEstimate && s.daysUntilNext !== null) {
    lines.push(
      s.daysUntilNext > 0
        ? `· 下一次大概在 ${s.nextEstimate}（还有 ${s.daysUntilNext} 天，只是估算）`
        : `· 预计的日子（${s.nextEstimate}）已经过了 ${-s.daysUntilNext} 天，可能不准`,
    );
  }
  return lines;
}

/* ─────────── 月视图 ─────────── */

export interface CalendarMonth {
  days: {
    day: string;
    state: DailyState | null;
    cycle: 'start' | 'end' | null;
    inPeriod: boolean;
  }[];
  cycle: CycleStatus;
}

export async function calendarMonth(year: number, month: number): Promise<CalendarMonth> {
  try {
    const from = `${year}-${String(month).padStart(2, '0')}-01`;
    const rows = await many<{ day: string; mood: string | null; energy: number | null; note: string | null }>(
      `select day::text, mood, energy, note from daily_states
        where day >= $1::date and day < ($1::date + interval '1 month')`,
      [from],
    );
    const cyc = await many<{ kind: string; day: string }>(
      `select kind, day::text from cycle_entries
        where day >= ($1::date - interval '10 days') and day < ($1::date + interval '1 month' + interval '10 days')`,
      [from],
    );

    const daysInMonth = new Date(year, month, 0).getDate();
    const states = new Map(rows.map((r) => [r.day, { day: r.day, mood: r.mood, energy: r.energy, note: r.note }]));
    const marks = new Map<string, 'start' | 'end'>();
    for (const c of cyc) marks.set(c.day, c.kind as 'start' | 'end');

    // 标记"在经期里"的日子：从某个 start 起，到下一个 end（或 +5 天）为止
    const starts = cyc.filter((c) => c.kind === 'start').map((c) => c.day).sort();
    const ends = cyc.filter((c) => c.kind === 'end').map((c) => c.day).sort();
    const inPeriodOn = (day: string) => {
      for (const s of starts) {
        if (day < s) continue;
        const end = ends.find((e) => e >= s);
        const stop = end ?? toDatePlus(s, 5);
        if (day <= stop) return true;
      }
      return false;
    };

    const days = Array.from({ length: daysInMonth }, (_, i) => {
      const day = `${year}-${String(month).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`;
      return {
        day,
        state: states.get(day) ?? null,
        cycle: marks.get(day) ?? null,
        inPeriod: inPeriodOn(day),
      };
    });

    return { days, cycle: await cycleStatus() };
  } catch (err) {
    log.error('读日历失败', errFields(err));
    return { days: [], cycle: { lastStart: null, ongoing: false, avgLengthDays: null, nextEstimate: null, daysUntilNext: null, samples: 0 } };
  }
}

function toDatePlus(day: string, n: number): string {
  const d = new Date(day);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
