import { many, one } from '../../db/pool.js';
import { log, errFields } from '../../logger.js';
import { compressSlice, type SliceMessage } from './index.js';
import { describeSegments, segmentMessages } from './segment.js';

/**
 * 滑出窗口的对话 -> 自动变成第一人称回忆。
 *
 * 两条账要同时算清楚：
 *   - **入库时间**（ingested_at）：记忆是什么时候被写下来的；
 *   - **事件时间**（event_time）：事情是什么时候发生的。
 * 所以压缩的输入必须带上每条消息真实的发生时间，而不是"现在"。
 *
 * 高水位线（high-water mark）：用 memory_items.source_to_seq 的最大值表示
 * "这个会话已经压到哪一条了"。这让整个流程天然幂等 —— 重复跑不会重复压缩。
 */

/** 保留最近这么多条作为原文上下文，不参与压缩 */
export const RAW_WINDOW = 20;

interface MessageRow {
  seq: string | number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  event_time: string;
}

export interface CompressRunResult {
  sessionId: string;
  candidates: number;
  segments: number;
  ok: number;
  failed: number;
  skipped?: string;
}

async function highWaterMark(sessionId: string): Promise<number> {
  const row = await one<{ hwm: string | number | null }>(
    `select max(source_to_seq) as hwm from memory_items where session_id = $1`,
    [sessionId],
  );
  return Number(row?.hwm ?? 0);
}

function toSlice(rows: MessageRow[]): SliceMessage[] {
  return rows.map((r) => ({ role: r.role, content: r.content, eventTime: r.event_time }));
}

/** 压缩一个会话里"已经滑出窗口、且尚未压缩"的部分 */
export async function compressOutOfWindow(
  sessionId: string,
  keepRecent = RAW_WINDOW,
): Promise<CompressRunResult> {
  const hwm = await highWaterMark(sessionId);
  const rows = await many<MessageRow>(
    `select seq, role, content, event_time
       from messages
      where session_id = $1 and seq > $2
      order by seq`,
    [sessionId, hwm],
  );

  // 最近 keepRecent 条留在窗口里当原文，不下沉成记忆
  const candidates = rows.slice(0, Math.max(0, rows.length - keepRecent));
  if (candidates.length === 0) {
    return { sessionId, candidates: rows.length, segments: 0, ok: 0, failed: 0, skipped: 'nothing-out-of-window' };
  }

  const segments = segmentMessages(toSlice(candidates));
  log.info('准备压缩滑出窗口的对话', {
    sessionId,
    pending: rows.length,
    candidates: candidates.length,
    segments: segments.length,
    layout: describeSegments(segments),
  });

  let ok = 0;
  let failed = 0;
  // 串行执行：这台机器只有 3.4GB，绝不并发压缩
  for (const seg of segments) {
    const fromSeq = Number((candidates.find((c) => c.content === seg[0]!.content) ?? candidates[0]!).seq);
    const lastContent = seg[seg.length - 1]!.content;
    const lastRow = [...candidates].reverse().find((c) => c.content === lastContent);
    const toSeq = Number(lastRow?.seq ?? fromSeq);

    try {
      const outcome = await compressSlice(seg, { sessionId, fromSeq, toSeq });
      if (outcome.ok) ok++;
      else failed++;
    } catch (err) {
      failed++;
      log.error('压缩某一段时异常', { sessionId, fromSeq, toSeq, ...errFields(err) });
    }
  }

  return { sessionId, candidates: candidates.length, segments: segments.length, ok, failed };
}

/** 会话结束时把剩下的（含窗口内）也压掉 */
export async function compressWholeSession(sessionId: string): Promise<CompressRunResult> {
  return compressOutOfWindow(sessionId, 0);
}

/** 找出所有"还有没压缩的滑出内容"的会话 —— 供 tick 定期扫 */
export async function findSessionsWithPending(limit = 3): Promise<{ session_id: string; pending: number }[]> {
  return many<{ session_id: string; pending: number }>(
    `select m.session_id, count(*)::int as pending
       from messages m
       left join (
         select session_id, max(source_to_seq) as hwm
           from memory_items
          where source_to_seq is not null
          group by session_id
       ) h on h.session_id = m.session_id
      where m.seq > coalesce(h.hwm, 0)
      group by m.session_id
      having count(*) > $1
      order by max(m.seq) desc
      limit $2`,
    [RAW_WINDOW, limit],
  );
}
