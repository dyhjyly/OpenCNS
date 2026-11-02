import { many } from '../db/pool.js';
import { log } from '../logger.js';
import { getSetting, setSetting } from '../settings/index.js';

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
/** 字数上限。7 天大概 6~8 万字 */
const CONTEXT_MAX_CHARS = 120_000;
/**
 * 超了之后一次裁到哪。
 *
 * **这是缓存命中率的关键。**
 * 原来是"超一个字就裁一条"：对话密集时每轮都裁掉最旧一条，
 * 于是历史前缀每轮都变，prompt 缓存全部失效（实测只命中 1,408 token，
 * 恰好是 system 那部分）。
 *
 * 现在留缓冲：只有超过上限才裁，而且一次裁到 85%，
 * 之后十来轮都不用再裁 —— 前缀稳定，缓存才吃得上。
 */
const CONTEXT_TRIM_TO = 0.85;
/** 无论如何至少带最近这么多条 */
const CONTEXT_MIN_MESSAGES = 20;

export type ContextMessage = { role: 'user' | 'assistant'; content: string };

export async function loadContextHistory(
  sessionId: string | null,
  currentText?: string,
): Promise<ContextMessage[]> {
  type Row = { seq: number; role: string; content: string; at: Date | string };

  /*
   * 锚定起点：上下文从哪一条开始，**记在设置里**，不是每轮现算。
   *
   * 这是缓存命中率的根。
   * 原来的做法是"取最近 7 天，超字数就从最旧裁掉"——可我们这个库常年顶在上限，
   * 于是**每说一句就裁掉最旧的一条**，历史前缀每轮都变，
   * prompt 缓存只能命中 system 那一小段（实测 1,408 token / 94,931）。
   *
   * 现在：起点锚一次，之后一直用它；只有当新内容把总字数撑到上限的 1.2 倍，
   * 才重新锚一次（一次裁到 85%）。这样前缀稳定，缓存才吃得上。
   */
  const anchoredSeq = Number(getSetting('context.head_seq', 0)) || 0;

  const where = sessionId
    ? `(session_id = $1::uuid or seq >= $2) and seq >= $2`
    : `seq >= $1`;

  const params = sessionId ? [sessionId, anchoredSeq] : [anchoredSeq];

  const rows = await many<Row>(
    `select seq, role, content, event_time as at
       from messages
      where ${where}
      order by seq asc`,
    params,
  ).catch(() => []);

  // 当前这句在 prepareTurn 里已经写进库了（dryRun 时没写），按内容去掉
  if (currentText && rows.length > 0) {
    const last = rows[rows.length - 1]!;
    if (last.role === 'user' && last.content.trim() === currentText.trim()) rows.pop();
  }

  const total = rows.reduce((n, r) => n + r.content.length, 0);

  let picked: Row[] = rows;

  // 只有撑破上限的 1.2 倍，才重新锚一次（裁到 85%）
  if (total > CONTEXT_MAX_CHARS * 1.2) {
    const target = CONTEXT_MAX_CHARS * CONTEXT_TRIM_TO;
    picked = [];
    let chars = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i]!;
      if (chars + r.content.length > target && picked.length >= CONTEXT_MIN_MESSAGES) break;
      picked.push(r);
      chars += r.content.length;
    }
    picked.reverse();

    const newHead = picked[0]?.seq ?? anchoredSeq;
    if (newHead !== anchoredSeq) {
      await setSetting('context.head_seq', newHead).catch(() => undefined);
      log.info('上下文重新锚定', { 从: anchoredSeq, 到: newHead, 条数: picked.length, 字数: chars });
    }
  }

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
    chars: picked.reduce((n, r) => n + r.content.length, 0),
    headSeq: picked[0]?.seq ?? null,
    from: picked[0] ? stampOf(picked[0].at) : null,
  });

  return picked.map((r) => ({
    role: r.role === 'assistant' ? ('assistant' as const) : ('user' as const),
    content: `${stampOf(r.at)} ${r.content}`,
  }));
}
