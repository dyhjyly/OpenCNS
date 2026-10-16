import { many, one, query } from '../db/pool.js';
import { log } from '../logger.js';

/**
 * 会话与消息的读写。
 *
 * 两条时间账在这里落地：
 *   event_time  = 这件事真实发生的时间（就是她说这句话的时刻）
 *   ingested_at = 落库时间
 * 正常对话两者几乎相同；但**回填历史**时必须写真实日期，
 * 否则几个月前的事全标成"今天"，时间感直接坏掉。
 */

export interface ActorNames {
  human: string;
  self: string;
}

let actorCache: ActorNames | null = null;

export async function getActorNames(): Promise<ActorNames> {
  if (actorCache) return actorCache;
  const rows = await many<{ kind: string; display_name: string }>(
    'select kind, display_name from actors',
  );
  const human = rows.find((r) => r.kind === 'human')?.display_name ?? '她';
  const self = rows.find((r) => r.kind === 'self')?.display_name ?? '我';
  actorCache = { human, self };
  return actorCache;
}

export async function ensureSession(sessionId?: string): Promise<string> {
  if (sessionId) {
    const existing = await one<{ id: string }>('select id from sessions where id = $1', [sessionId]);
    if (existing) {
      await query('update sessions set last_activity_at = now() where id = $1', [sessionId]);
      return existing.id;
    }
    log.warn('传入的 sessionId 不存在，改为新建会话', { sessionId });
  }
  const created = await one<{ id: string }>(
    'insert into sessions (started_at, last_activity_at) values (now(), now()) returning id',
  );
  if (!created) throw new Error('新建会话失败');
  return created.id;
}

export async function appendMessage(
  sessionId: string,
  role: 'user' | 'assistant' | 'system',
  content: string,
  meta: Record<string, unknown> = {},
): Promise<void> {
  await query(
    `insert into messages (session_id, role, content, event_time, ingested_at, meta)
     values ($1, $2, $3, now(), now(), $4::jsonb)`,
    [sessionId, role, content, JSON.stringify(meta)],
  );
  await query('update sessions set last_activity_at = now() where id = $1', [sessionId]);
}

export interface StoredMessage {
  seq: string | number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  event_time: string;
}

export async function recentMessages(sessionId: string, limit = 20): Promise<StoredMessage[]> {
  const rows = await many<StoredMessage>(
    `select seq, role, content, event_time
       from messages
      where session_id = $1
      order by seq desc
      limit $2`,
    [sessionId, limit],
  );
  return rows.reverse();
}

export async function closeSession(sessionId: string): Promise<void> {
  await query('update sessions set ended_at = now() where id = $1', [sessionId]);
}
