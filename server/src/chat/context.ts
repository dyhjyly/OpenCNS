import { many } from '../db/pool.js';
import { log } from '../logger.js';

/**
 * 这一轮要带进上下文的对话原文。
 *
 * 聊天和"醒来"共用这一份 —— 醒来也要看到同一段对话，
 * 否则他醒来就是个不记得刚才说过什么的人（这正是之前的毛病）。
 *
 * 四条铁律：
 *   1. **每条都带时间戳** [10-19 21:03] —— 否则他把十天前的话当成"刚说的"。
 *   2. **落单的 assistant 丢掉** —— 它的提问被挤掉了，看起来就是半句话。
 *   3. 窗口 7 天；更早的交给记忆和周记。
 *   4. 最近 20 条一定在（连续性的下限）。
 */

/** 上下文带多久的对话 —— 周记按周写，窗口给到一周 */
const CONTEXT_HOURS = 24 * 7;
/** 字数上限。7 天大概 6~8 万字，留一点余量 */
const CONTEXT_MAX_CHARS = 120_000;
/** 无论如何至少带最近这么多条 */
const CONTEXT_MIN_MESSAGES = 20;

export type ContextMessage = { role: 'user' | 'assistant'; content: string };

export async function loadContextHistory(
  sessionId: string | null,
  currentText?: string,
): Promise<ContextMessage[]> {
  const rows = sessionId
    ? await many<{ role: string; content: string; at: Date | string }>(
        `select role, content, event_time as at
           from messages
          where session_id = $1::uuid
             or event_time > now() - ($2 || ' hours')::interval
          order by seq asc`,
        [sessionId, String(CONTEXT_HOURS)],
      ).catch(() => [])
    : await many<{ role: string; content: string; at: Date | string }>(
        `select role, content, event_time as at
           from messages
          where event_time > now() - ($1 || ' hours')::interval
          order by seq asc`,
        [String(CONTEXT_HOURS)],
      ).catch(() => []);

  // 当前这句在 prepareTurn 里已经写进库了（dryRun 时没写），按内容去掉
  if (currentText && rows.length > 0) {
    const last = rows[rows.length - 1]!;
    if (last.role === 'user' && last.content.trim() === currentText.trim()) rows.pop();
  }

  // 从最近往回取：超字数预算才停，但前 CONTEXT_MIN_MESSAGES 条一律保留
  type Row = { role: string; content: string; at: Date | string };
  const picked: Row[] = [];
  let chars = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    const overBudget = chars + r.content.length > CONTEXT_MAX_CHARS;
    if (overBudget && picked.length >= CONTEXT_MIN_MESSAGES) break;
    picked.push(r);
    chars += r.content.length;
  }
  picked.reverse();

  // 首条若是 assistant，丢掉（它是半句话）
  const head = picked[0];
  if (head && head.role === 'assistant') picked.shift();

  const stampOf = (at: Date | string): string => {
    const d = new Date(at);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `[${mm}-${dd} ${hh}:${mi}]`;
  };

  log.info('上下文窗口', {
    messages: picked.length,
    chars,
    hours: CONTEXT_HOURS,
    from: picked[0] ? stampOf(picked[0].at) : null,
  });

  return picked.map((r) => ({
    role: r.role === 'assistant' ? ('assistant' as const) : ('user' as const),
    content: `${stampOf(r.at)} ${r.content}`,
  }));
}
