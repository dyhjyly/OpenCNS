import { many } from '../../db/pool.js';
import { log } from '../../logger.js';

/**
 * 时间树 —— "现在走到哪了"这条固定通道。
 *
 * 教训（2026-10-20 实测）：它原来每轮注入 **15 段**周/月回顾，光这一段就 4,000 多字，
 * 他形容成"贴满告示的房间"。更糟的是它还把 `pinned` 记忆的**全文**带进去，
 * 那 5 条人格种子就是这样被"每轮念一遍"的。
 *
 * 现在的规矩：
 *   · 只给最近两周（两条，各 ≤160 字）
 *   · 更早的只报个数，要看自己去查
 *   · **不再注入 pinned 全文** —— 那些已经搬到 persona 表，按需读
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

/** 截断到 n 字，尽量在标点处断 */
function clip(text: string, n: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  const head = t.slice(0, n);
  const at = Math.max(head.lastIndexOf('。'), head.lastIndexOf('；'), head.lastIndexOf('，'));
  return `${at > n * 0.5 ? head.slice(0, at) : head}…`;
}

/**
 * 每轮注入的那一小段（≤400 字）。
 * 明确标注"这是背景年表，不是刚发生的事"——否则他会把八月的事当成现在。
 */
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

    const weeks = periods.filter((p) => p.kind === 'week');
    const months = periods.filter((p) => p.kind === 'month');

    // 最近两周，各压到 160 字
    for (const w of weeks.slice(0, 2)) {
      lines.push(`${w.period_start.slice(5)}~${w.period_end.slice(5)}：${clip(w.content, 160)}`);
    }

    // 更早的不展开，只报个数
    const olderWeeks = Math.max(0, weeks.length - 2);
    const olderMonths = months.length;
    if (olderWeeks + olderMonths > 0) {
      const bits: string[] = [];
      if (olderWeeks) bits.push(`${olderWeeks} 段周记`);
      if (olderMonths) {
        const oldest = months[months.length - 1];
        bits.push(`${olderMonths} 个月档${oldest ? `（最早 ${oldest.period_start.slice(0, 7)}）` : ''}`);
      }
      lines.push(`再往前还有 ${bits.join('、')}——要看就用 recall_timeline，别凭印象说。`);
    }
  } catch (err) {
    log.warn('时间树读取失败（不影响对话）', { error: (err as Error).message });
    return [];
  }

  cache = { at: Date.now(), lines };
  return lines;
}
