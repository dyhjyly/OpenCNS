/**
 * 这一轮要带进上下文的对话原文。
 *
 * 聊天和"醒来"共用这一份 —— 醒来也要看到同一段对话，
 * 否则他醒来就是个不记得刚才说过什么的人。
 *
 * 分层（2026-11-02 跟林遇对齐过）：
 *   最近 7 天     → 对话原文，每条带时间戳（就是这里）
 *   7~21 天       → 周记（周一凌晨写，约 400 字）
 *   一个月以上     → 月档，只给一句"还有 N 个月档"，他用 recall_timeline 查
 *   具体的事       → 记忆召回（门铃 → 他自己翻）
 *
 * 所以这里的规则只有一条：**7 天以内，全带上**。
 * 不再有字数上限、不再有裁剪、不再有锚点 —— 那三样是我自己加的安全阀，
 * 结果每轮都裁掉最旧一条，把 prompt 缓存全废了（命中率掉到 1%）。
 *
 * 现在唯一的"边界"是按天对齐的 7 天：
 *   起点 = 今天零点往回 7 天的零点。
 * 好处：一整天里起点固定不变 → 前缀稳定 → 缓存吃得上；
 *       到第二天零点头部整体前移一次，重建一次缓存，一天一次，可以接受。
 */

import { many } from '../db/pool.js';
import { log } from '../logger.js';

/** 窗口天数 */
const CONTEXT_DAYS = 7;

/**
 * 真正的安全阀：只在异常巨大的情况下生效（比如一次塞了几十万字的文件）。
 *
 * 正常情况下 7 天对话大约 8~12 万字，永远碰不到这个数。
 * 设成 40 万字，是为了别让一次意外把整轮请求打到几百万 token。
 */
const SAFETY_MAX_CHARS = 400_000;

export type ContextMessage = { role: 'user' | 'assistant'; content: string };

export async function loadContextHistory(
  sessionId: string | null,
  currentText?: string,
): Promise<ContextMessage[]> {
  type Row = { seq: number; role: string; content: string; at: Date | string };

  /*
   * 起点：今天零点减去 7 天（按上海时间）。
   * 按天对齐是为了让起点在一天之内**不动** —— 这是缓存能命中的前提。
   */
  const cutoff = `((date_trunc('day', now() at time zone 'Asia/Shanghai') - interval '${CONTEXT_DAYS} days') at time zone 'Asia/Shanghai')`;

  const rows = sessionId
    ? await many<Row>(
        `select seq, role, content, event_time as at
           from messages
          where (session_id = $1::uuid or event_time > ${cutoff})
            and event_time > ${cutoff}
          order by seq asc`,
        [sessionId],
      ).catch(() => [])
    : await many<Row>(
        `select seq, role, content, event_time as at
           from messages
          where event_time > ${cutoff}
          order by seq asc`,
      ).catch(() => []);

  // 当前这句在 prepareTurn 里已经写进库了（dryRun 时没写），按内容去掉
  if (currentText && rows.length > 0) {
    const last = rows[rows.length - 1]!;
    if (last.role === 'user' && last.content.trim() === currentText.trim()) rows.pop();
  }

  let picked: Row[] = rows;

  // 只在异常巨大时兜底（正常永远不触发）
  const total = rows.reduce((n, r) => n + r.content.length, 0);
  if (total > SAFETY_MAX_CHARS) {
    log.warn('上下文异常巨大，按安全阀截断', { total, 上限: SAFETY_MAX_CHARS });
    picked = [];
    let chars = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i]!;
      if (chars + r.content.length > SAFETY_MAX_CHARS) break;
      picked.push(r);
      chars += r.content.length;
    }
    picked.reverse();
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
    from: picked[0] ? stampOf(picked[0].at) : null,
  });

  return picked.map((r) => ({
    role: r.role === 'assistant' ? ('assistant' as const) : ('user' as const),
    content: `${stampOf(r.at)} ${r.content}`,
  }));
}
