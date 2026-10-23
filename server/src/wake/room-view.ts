import { many, one } from '../db/pool.js';

/**
 * 醒来房间 —— 他独处时留下的东西。
 *
 * 内容是后端生成的（节拍器 → 房间 → 决定 → 写经历），前端只负责呈现。
 * 惊喜对她隐藏，到 reveal_at 才解开。
 */

export interface WakeRoomEntry {
  id: number;
  at: string;
  decision: string | null;
  /** 这一轮实际做了哪几件 */
  actions: string[];
  /** 手动叫醒的（不是节拍器自己开的窗） */
  forced: boolean;
  skipped: string | null;
  modelCalls: number;
  /** 这一次醒来留下的经历（如果有） */
  did: string | null;
}

export interface WakeRoomView {
  entries: WakeRoomEntry[];
  notes: { id: string; kind: string; content: string; expiresAt: string | null }[];
  surprises: { id: string; content: string; revealAt: string; revealed: boolean }[];
  lockedSurprises: number;
  /** 他拍拍她的记录 */
  pats: { at: string; suffix: string | null }[];
  /** 他凌晨写下的日记（每日记忆） */
  diaries: { id: string; at: string; kind: string; content: string }[];
  counts: { wakes: number; decided: number; skipped: number };
}

export async function getWakeRoom(limit = 20): Promise<WakeRoomView> {
  const wakes = await many<{
    id: number;
    created_at: string;
    decision: string | null;
    actions: unknown;
    forced: boolean;
    skipped_reason: string | null;
    model_calls: number;
  }>(
    `select id, created_at, decision, actions, coalesce(forced,false) as forced, skipped_reason, model_calls
       from wake_log order by created_at desc limit $1`,
    [limit],
  );

  // 每次醒来写下的经历：按唤醒时间就近匹配（同一个时间窗内的 experience）
  const experiences = await many<{ content: string; ingested_at: string; wake_id: number | null }>(
    `select content, ingested_at, (provenance->>'wake_id')::int as wake_id
       from memory_items
      where kind = 'experience' and provenance->>'source' = 'wake'
      order by ingested_at desc limit 40`,
  );
  const expByWake = new Map<number, string>();
  for (const e of experiences) {
    if (e.wake_id !== null) expByWake.set(Number(e.wake_id), e.content);
  }

  const entries: WakeRoomEntry[] = wakes.map((w) => {
    let did = expByWake.get(Number(w.id)) ?? null;
    if (!did) {
      // 没有 wake_id 的旧记录：按时间就近找一条
      const t = new Date(w.created_at).getTime();
      const near = experiences.find(
        (e) => Math.abs(new Date(e.ingested_at).getTime() - t) < 3 * 60_000,
      );
      did = near?.content ?? null;
    }
    return {
      id: Number(w.id),
      at: w.created_at,
      decision: w.decision,
      actions: Array.isArray(w.actions) ? (w.actions as string[]) : [],
      forced: Boolean(w.forced),
      skipped: w.decision ? null : w.skipped_reason,
      modelCalls: w.model_calls,
      did,
    };
  });

  const notes = await many<{ id: string; kind: string; content: string; expires_at: string | null }>(
    `select id, kind, content, expires_at
       from notes where status = 'open'
      order by created_at desc limit 12`,
  );

  const surprises = await many<{
    id: string;
    content: string;
    reveal_at: string;
    revealed_at: string | null;
  }>(
    `select id, content, reveal_at, revealed_at
       from surprises
      where cancelled_at is null
      order by reveal_at asc`,
  );

  const now = Date.now();
  const visible: WakeRoomView['surprises'] = [];
  let locked = 0;
  for (const s of surprises) {
    const due = new Date(s.reveal_at).getTime() <= now;
    if (!due) {
      locked++;
      continue;
    }
    visible.push({ id: s.id, content: s.content, revealAt: s.reveal_at, revealed: Boolean(s.revealed_at) });
  }

  const counts = await one<{ wakes: number; decided: number; skipped: number }>(
    `select count(*)::int as wakes,
            count(*) filter (where decision is not null)::int as decided,
            count(*) filter (where decision is null)::int as skipped
       from wake_log`,
  );

  const pats = await many<{ at: string; suffix: string | null }>(
    `select created_at as at, suffix from pats
      where from_who = 'self'
      order by created_at desc limit 10`,
  ).catch(() => []);

  /*
   * 日记：**每天凌晨写的那一篇**。
   *
   * 原来的条件太宽（source='self' 全收），结果把"我发了一条动态：…"这类
   * 来自社交动作的经历也捞了进来 —— 她看到的"日记"里一半是动态。
   * 现在只认 via='nightly' 的 reflection：夜里记忆时间写的那一篇。
   */
  const diaries = await many<{ id: string; at: string; kind: string; content: string }>(
    `select distinct on ((ingested_at at time zone 'Asia/Shanghai')::date)
            id::text, ingested_at as at, kind, content
       from memory_items
      where state = 'active'
        and provenance->>'source' = 'self'
        and provenance->>'via' = 'nightly'
        and kind = 'reflection'
      order by (ingested_at at time zone 'Asia/Shanghai')::date desc, length(content) desc
      limit 30`,
  ).catch(() => []);

  return {
    entries,
    notes: notes.map((n) => ({ id: n.id, kind: n.kind, content: n.content, expiresAt: n.expires_at })),
    surprises: visible,
    lockedSurprises: locked,
    pats,
    diaries: diaries.map((d) => ({ id: d.id, at: d.at, kind: d.kind, content: d.content })),
    counts: counts ?? { wakes: 0, decided: 0, skipped: 0 },
  };
}
