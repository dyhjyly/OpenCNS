/**
 * 这一轮要带进上下文的对话原文。
 *
 * 聊天和"醒来"共用这一份 —— 醒来也要看到同一段对话。
 *
 * 分层（2026-11-02 跟林遇对齐，最终版）：
 *   本周            → 对话原文，每条带时间戳
 *   上周（已写周记）→ **只剩最近 20 条**兜底，其余由周记代表
 *   7~21 天         → 周记
 *   一个月以上       → 月档（只给"还有 N 个月档"，要用 recall_timeline 查）
 *   具体的事         → 记忆召回（门铃 → 他自己翻）
 *
 * 关键：**周记写完就把那一周的原文换掉**。
 * 周一 03:00 写完上一周的周记之后，上周的对话不再整段带，
 * 只留 20 条接续（保证"接着刚才那句话说"不断片）。
 *
 * 缓存友好：切换点在周一零点，一周只变一次；那一周之内前缀完全稳定。
 */

import { many, one } from '../db/pool.js';
import { log } from '../logger.js';

/** 没有周记时（比如刚装好）退化成纯 7 天窗口 */
const FALLBACK_DAYS = 7;
/** 已写周记的那一周，只保留最近这么多条兜底 */
const BRIDGE_MESSAGES = 20;
/** 安全阀：只在异常巨大时生效，防一次塞几十万字把请求打爆 */
const SAFETY_MAX_CHARS = 400_000;

export type ContextMessage = { role: 'user' | 'assistant'; content: string };

export async function loadContextHistory(
  sessionId: string | null,
  currentText?: string,
): Promise<ContextMessage[]> {
  type Row = { seq: number; role: string; content: string; at: Date | string };

  /*
   * 1) 上周的周记写到哪儿了？
   *    period_end 是周日，所以"本周起点" = 周一零点。
   */
  const latestWeek = await one<{ end: string }>(
    `select period_end::text as end from timeline_periods where kind = 'week' order by period_end desc limit 1`,
  ).catch(() => null);

  const weekStart = latestWeek
    ? `((('${latestWeek.end}'::date + 1)::timestamp) at time zone 'Asia/Shanghai')`
    : null;

  const fallbackCutoff = `((date_trunc('day', now() at time zone 'Asia/Shanghai') - interval '${FALLBACK_DAYS} days') at time zone 'Asia/Shanghai')`;

  const afterCutoff = weekStart ?? fallbackCutoff;

  /* 2) 本周的原文 */
  const raw = sessionId
    ? await many<Row>(
        `select seq, role, content, event_time as at
           from messages
          where (session_id = $1::uuid or event_time >= ${afterCutoff})
            and event_time >= ${afterCutoff}
          order by seq asc`,
        [sessionId],
      ).catch(() => [])
    : await many<Row>(
        `select seq, role, content, event_time as at
           from messages
          where event_time >= ${afterCutoff}
          order by seq asc`,
      ).catch(() => []);

  /* 3) 上周只留最近 20 条兜底（写在周记覆盖之后） */
  let bridge: Row[] = [];
  if (weekStart) {
    bridge = await many<Row>(
      `select seq, role, content, event_time as at
         from messages
        where event_time < ${afterCutoff}
        order by seq desc
        limit ${BRIDGE_MESSAGES}`,
    ).catch(() => []);
    bridge.reverse();
  }

  let rows: Row[] = [...bridge, ...raw];

  // 当前这句在 prepareTurn 里已经写进库了（dryRun 时没写），按内容去掉
  if (currentText && rows.length > 0) {
    const last = rows[rows.length - 1]!;
    if (last.role === 'user' && last.content.trim() === currentText.trim()) rows.pop();
  }

  let picked: Row[] = rows;

  // 安全阀：正常永远不触发
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
    本周原文: raw.length,
    上周兜底: bridge.length,
    周记覆盖至: latestWeek?.end ?? null,
    from: picked[0] ? stampOf(picked[0].at) : null,
  });

  return picked.map((r) => ({
    role: r.role === 'assistant' ? ('assistant' as const) : ('user' as const),
    content: `${stampOf(r.at)} ${r.content}`,
  }));
}
