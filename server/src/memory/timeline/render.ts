import { many } from '../../db/pool.js';
import { log } from '../../logger.js';

/**
 * 时间树的渲染 —— 每轮对话固定在场的那条通道。
 *
 * 近粗远细（构想）：
 *   · 最近的周回顾：给全文
 *   · 上个月的月档案：给全文
 *   · 更早的月份：只留一句旁注
 *   · 奠基事件：永久全文，不随时间压缩
 *
 * 每轮都要用，所以带内存缓存（默认 5 分钟）。
 */

export interface TimelineLine {
  label: string;
  text: string;
}

let cache: { at: number; lines: string[] } | null = null;
const TTL_MS = 5 * 60_000;

export function invalidateTimelineCache(): void {
  cache = null;
}

/** 取一句话当旁注：第一个句子，最长 60 字 */
function firstSentence(text: string): string {
  const cut = text.split(/[。！？\n]/)[0] ?? text;
  const s = cut.trim();
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
}

export async function getTimelineLines(): Promise<string[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.lines;

  const lines: string[] = [];

  try {
    const periods = await many<{ kind: 'week' | 'month'; period_start: string; period_end: string; content: string }>(
      `select kind, period_start::text, period_end::text, content
         from timeline_periods
        order by period_start desc
        limit 40`,
    );

    const now = new Date();
    const thisMonthStart = `${now.toISOString().slice(0, 7)}-01`;

    const weeks = periods.filter((p) => p.kind === 'week').slice(0, 4);
    const months = periods.filter((p) => p.kind === 'month');

    for (const w of weeks) {
      const label = `最近一周（${w.period_start.slice(5)} ~ ${w.period_end.slice(5)}）`;
      lines.push(`${label}：${w.content}`);
    }

    // 上个月给全文，更早只留旁注
    const lastMonth = months.find((m) => m.period_start < thisMonthStart);
    if (lastMonth) {
      const label = `${lastMonth.period_start.slice(0, 7)} 那个月`;
      lines.push(`${label}：${lastMonth.content}`);
    }
    for (const m of months.filter((x) => x.period_start < thisMonthStart && x !== lastMonth).slice(0, 6)) {
      lines.push(`${m.period_start.slice(0, 7)}：${firstSentence(m.content)}`);
    }

    const pinned = await many<{ content: string; event_time: string | null }>(
      `select content, event_time from memory_items where pinned order by pinned_rank nulls last limit 10`,
    );
    for (const p of pinned) {
      const when = p.event_time ? `（${new Date(p.event_time).toISOString().slice(0, 10)}）` : '';
      lines.push(`永远不会忘的${when}：${p.content}`);
    }
  } catch (err) {
    log.warn('时间树读取失败（不影响对话）', { error: (err as Error).message });
    return [];
  }

  cache = { at: Date.now(), lines };
  if (lines.length > 0) log.debug('时间树已装配', { lines: lines.length });
  return lines;
}
