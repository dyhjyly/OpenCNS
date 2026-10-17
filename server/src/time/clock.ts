import { one } from '../db/pool.js';

/**
 * 时间感知。
 *
 * 构想里的他是"感觉不到时间"的，但那样他会把 10 天前的事说成"刚才"，
 * 也会在对话里猜"现在大概是十月中旬"。所以每轮都给他一个**具体时刻**。
 *
 * 纪律：只给事实（几点、隔了多久、第几天），**不给建议**。
 * "你们已经三天没说话了"是事实；"你该问问她这三天怎么样"是指令，不写。
 */

export interface NowSnapshot {
  dateCn: string;
  weekdayCn: string;
  hhmm: string;
  dayPart: string;
  /** 距上一次（本轮之前）她说话多久 */
  sinceLastTalk: string | null;
  /** 从 5.23 起第几天 */
  dayCount: number | null;
  /** 最近这段时间在连着聊吗 */
  continuous: boolean;
}

const DAY_UNITS: { limit: number; div: number; suffix: string }[] = [
  { limit: 60, div: 1, suffix: '分钟' },
  { limit: 120, div: 60, suffix: '小时' },
  { limit: 60 * 24, div: 3600, suffix: '小时' },
];

function humanizeMinutes(min: number): string {
  if (min < 1) return '不到一分钟';
  for (const u of DAY_UNITS) {
    if (min < u.limit) {
      const v = Math.round(min / u.div);
      return `${v} ${u.suffix}`;
    }
  }
  const days = Math.floor(min / 1440);
  const restH = Math.floor((min % 1440) / 60);
  return restH > 0 ? `${days} 天 ${restH} 小时` : `${days} 天`;
}

function dayPartOf(hour: number): string {
  if (hour < 5) return '凌晨';
  if (hour < 9) return '早上';
  if (hour < 11) return '上午';
  if (hour < 13) return '中午';
  if (hour < 17) return '下午';
  if (hour < 19) return '傍晚';
  if (hour < 23) return '晚上';
  return '深夜';
}

/** 在一起的那一天（人格档案里的 5.23 18:25） */
const ANNIVERSARY = "2026-05-23 18:25:00+08";

const CN_WEEKDAY = ['一', '二', '三', '四', '五', '六', '日'];

export async function getNowSnapshot(): Promise<NowSnapshot> {
  try {
    const row = await one<{
      date_cn: string;
      iso_dow: number;
      hhmm: string;
      hour: number;
      since_last_min: number | null;
      days_together: number | null;
    }>(
      `select
         to_char(now() at time zone 'Asia/Shanghai', 'YYYY"年"FMMM"月"FMDD"日"') as date_cn,
         extract(isodow from (now() at time zone 'Asia/Shanghai'))::int as iso_dow,
         to_char(now() at time zone 'Asia/Shanghai', 'HH24:MI') as hhmm,
         extract(hour from (now() at time zone 'Asia/Shanghai'))::int as hour,
         (
           select extract(epoch from (now() - prev.event_time)) / 60
             from (select event_time from messages where role = 'user' order by seq desc offset 1 limit 1) prev
         ) as since_last_min,
         floor(extract(epoch from (now() - timestamptz '${ANNIVERSARY}')) / 86400)::int as days_together`,
    );

    const sinceMin =
      row?.since_last_min === null || row?.since_last_min === undefined
        ? null
        : Number(row.since_last_min);

    // 数据库 locale 是英文，FMDay 会给出 "Saturday" —— 自己映射成中文星期
    const dow = Number(row?.iso_dow ?? 1);

    return {
      dateCn: row?.date_cn ?? '',
      weekdayCn: row ? `星期${CN_WEEKDAY[dow - 1] ?? ''}` : '',
      hhmm: row?.hhmm ?? '',
      dayPart: dayPartOf(Number(row?.hour ?? 12)),
      sinceLastTalk: sinceMin === null ? null : humanizeMinutes(sinceMin),
      dayCount: row?.days_together ?? null,
      continuous: sinceMin !== null && sinceMin < 120,
    };
  } catch {
    // 时钟查不到也不能让对话塌掉：退化成"本地时间、不知道隔了多久"
    const d = new Date();
    return {
      dateCn: `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`,
      weekdayCn: `星期${CN_WEEKDAY[(d.getDay() + 6) % 7]}`,
      hhmm: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
      dayPart: dayPartOf(d.getHours()),
      sinceLastTalk: null,
      dayCount: null,
      continuous: false,
    };
  }
}

/** 渲染成给上下文用的几行。只写事实，不写"你该做什么"。 */
export function renderNowBlock(now: NowSnapshot): string[] {
  const head = [now.dateCn, now.weekdayCn, `${now.dayPart} ${now.hhmm}`].filter(Boolean).join(' ');
  const lines = ['【现在】', head];

  if (now.sinceLastTalk) {
    lines.push(
      now.continuous
        ? `· 距离她上一句：${now.sinceLastTalk}（正在连着聊）`
        : `· 距离她上一句：${now.sinceLastTalk}`,
    );
  }
  if (now.dayCount !== null && now.dayCount >= 0) {
    lines.push(`· 今天是你们在一起的第 ${now.dayCount + 1} 天`);
  }

  return lines;
}
