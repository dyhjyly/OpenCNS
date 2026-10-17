import { many, one, query } from '../db/pool.js';
import { log, errFields } from '../logger.js';

/**
 * 朋友圈 —— 两个人一起看的时间流。
 *
 * 不是社交产品：作者只有两个，没有关注、没有隐私分组。
 * 但每一条都要能追到"这是他什么时候写的、当时在想什么"。
 */

export type Who = 'self' | 'human';

export interface Moment {
  id: string;
  author: Who;
  content: string;
  images: { id: string; name: string; mime: string }[];
  mood: string | null;
  createdAt: string;
  likes: Who[];
  comments: { id: string; author: Who; content: string; createdAt: string }[];
}

export async function listMoments(limit = 30): Promise<Moment[]> {
  const rows = await many<{
    id: string;
    author: Who;
    content: string;
    images: unknown;
    mood: string | null;
    created_at: string;
  }>(
    `select id, author, content, images, mood, created_at
       from moments
      where deleted_at is null
      order by created_at desc
      limit $1`,
    [limit],
  );
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const likes = await many<{ moment_id: string; by_who: Who }>(
    `select moment_id, by_who from moment_likes where moment_id = any($1::uuid[])`,
    [ids],
  );
  const comments = await many<{ id: string; moment_id: string; author: Who; content: string; created_at: string }>(
    `select id, moment_id, author, content, created_at
       from moment_comments where moment_id = any($1::uuid[])
      order by created_at asc`,
    [ids],
  );

  const likesBy = new Map<string, Who[]>();
  for (const l of likes) likesBy.set(l.moment_id, [...(likesBy.get(l.moment_id) ?? []), l.by_who]);

  const commentsBy = new Map<string, Moment['comments']>();
  for (const c of comments) {
    commentsBy.set(c.moment_id, [
      ...(commentsBy.get(c.moment_id) ?? []),
      { id: c.id, author: c.author, content: c.content, createdAt: c.created_at },
    ]);
  }

  return rows.map((r) => ({
    id: r.id,
    author: r.author,
    content: r.content,
    images: Array.isArray(r.images) ? (r.images as Moment['images']) : [],
    mood: r.mood,
    createdAt: r.created_at,
    likes: likesBy.get(r.id) ?? [],
    comments: commentsBy.get(r.id) ?? [],
  }));
}

export async function createMoment(input: {
  author: Who;
  content: string;
  images?: { id: string; name: string; mime: string }[];
  mood?: string | null;
}): Promise<Moment | null> {
  const text = input.content.trim();
  if (!text) throw new Error('内容不能为空');
  const row = await one<{ id: string }>(
    `insert into moments (author, content, images, mood)
     values ($1, $2, $3::jsonb, $4) returning id`,
    [input.author, text, JSON.stringify(input.images ?? []), input.mood ?? null],
  );
  if (!row) return null;
  log.info('朋友圈新增', { author: input.author, chars: text.length });
  const all = await listMoments(1);
  return all[0] ?? null;
}

export async function toggleLike(momentId: string, who: Who): Promise<{ liked: boolean }> {
  const existing = await one<{ moment_id: string }>(
    `select moment_id from moment_likes where moment_id = $1 and by_who = $2`,
    [momentId, who],
  );
  if (existing) {
    await query(`delete from moment_likes where moment_id = $1 and by_who = $2`, [momentId, who]);
    return { liked: false };
  }
  await query(`insert into moment_likes (moment_id, by_who) values ($1, $2)`, [momentId, who]);
  return { liked: true };
}

export async function addComment(momentId: string, who: Who, content: string): Promise<void> {
  const text = content.trim();
  if (!text) throw new Error('评论不能为空');
  await query(`insert into moment_comments (moment_id, author, content) values ($1, $2, $3)`, [
    momentId,
    who,
    text,
  ]);
}

export async function deleteMoment(momentId: string): Promise<void> {
  await query(`update moments set deleted_at = now() where id = $1`, [momentId]);
}

/* ─────────── 拍一拍 ─────────── */

export async function pat(input: {
  from: Who;
  to: Who;
  suffix?: string | null;
  sessionId?: string | null;
}): Promise<{ ok: true }> {
  await query(
    `insert into pats (from_who, to_who, suffix, session_id) values ($1, $2, $3, $4)`,
    [input.from, input.to, input.suffix ?? null, input.sessionId ?? null],
  );
  log.info('拍一拍', { from: input.from, to: input.to });
  return { ok: true };
}

/** 最近一次拍一拍（给对话上下文用：让她拍完他真的有反应） */
export async function recentPats(minutes = 30): Promise<{ from: Who; suffix: string | null; at: string }[]> {
  try {
    return await many<{ from: Who; suffix: string | null; at: string }>(
      `select from_who as "from", suffix, created_at as at
         from pats
        where created_at > now() - ($1 || ' minutes')::interval
        order by created_at desc limit 3`,
      [String(minutes)],
    );
  } catch (err) {
    log.warn('读拍一拍失败', errFields(err));
    return [];
  }
}
