#!/usr/bin/env node
/**
 * 把旧库 recent_chat 里仅存的对话记录迁进 v2 的 sessions / messages。
 *
 * 为什么值得做：
 *   1) 这是旧系统里唯一还留着的原始对话（被裁到 100 条），不迁就永远丢了；
 *   2) v2 的压缩器需要真实对话来验收 —— 用编造的数据测不出问题。
 *
 * 幂等：以 messages.meta.source = 'legacy-recent-chat' 为标记，迁过就跳过。
 * 事件时间：用旧的 created_at，不是"现在"（两本时间账）。
 */

import { readFileSync } from 'node:fs';
import pg from 'pg';

function loadEnv(file) {
  const out = {};
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const i = s.indexOf('=');
      if (i === -1) continue;
      out[s.slice(0, i).trim()] = s.slice(i + 1).trim().replace(/\r$/, '').replace(/^["']|["']$/g, '');
    }
  } catch {
    /* ignore */
  }
  return out;
}

const legacyEnv = loadEnv('/home/ubuntu/mcp-memory-server/.env');
const appEnv = loadEnv('/opt/opencns/server/.env');

const SB_URL = (legacyEnv.SUPABASE_URL ?? '').replace(/\/+$/, '');
const SB_KEY = legacyEnv.SUPABASE_KEY ?? '';
const DB_URL = appEnv.DATABASE_URL ?? '';

if (!SB_URL || !SB_KEY) {
  console.error('读不到旧库凭据（/home/ubuntu/mcp-memory-server/.env）');
  process.exit(2);
}
if (!DB_URL) {
  console.error('读不到 v2 数据库连接串（/opt/opencns/server/.env）');
  process.exit(2);
}

async function rest(path) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}` },
  });
  if (!res.ok) throw new Error(`REST ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

console.log('拉取旧库 recent_chat ...');
const rows = await rest(
  'recent_chat?select=id,session_id,sequence,role,content,created_at&order=session_id.asc,sequence.asc&limit=2000',
);
console.log(`拿到 ${rows.length} 条`);

const bySession = new Map();
for (const r of rows) {
  if (!bySession.has(r.session_id)) bySession.set(r.session_id, []);
  bySession.get(r.session_id).push(r);
}
console.log(`分属 ${bySession.size} 个旧会话`);

const client = new pg.Client({ connectionString: DB_URL });
await client.connect();

const guard = await client.query(
  `select count(*)::int as n from messages where meta->>'source' = 'legacy-recent-chat'`,
);
if (guard.rows[0].n > 0) {
  console.log(`已经迁移过 ${guard.rows[0].n} 条，跳过（幂等）`);
  await client.end();
  process.exit(0);
}

let insertedSessions = 0;
let insertedMessages = 0;

for (const [legacySid, msgs] of bySession) {
  const first = msgs[0];
  const last = msgs[msgs.length - 1];
  const title = `legacy ${String(legacySid).slice(0, 8)}`;
  const sres = await client.query(
    `insert into sessions (title, started_at, last_activity_at) values ($1, $2, $3) returning id`,
    [title, first.created_at, last.created_at],
  );
  const sessionId = sres.rows[0].id;
  insertedSessions++;

  for (const m of msgs) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    await client.query(
      `insert into messages (session_id, role, content, event_time, ingested_at, meta)
       values ($1, $2, $3, $4, $4, $5::jsonb)`,
      [
        sessionId,
        role,
        m.content,
        m.created_at,
        JSON.stringify({ source: 'legacy-recent-chat', legacy_id: m.id, legacy_session: legacySid }),
      ],
    );
    insertedMessages++;
  }
  console.log(`  ${title}: ${msgs.length} 条  (${first.created_at} ~ ${last.created_at})`);
}

const summary = await client.query(
  `select (select count(*) from sessions)::int as sessions, (select count(*) from messages)::int as messages`,
);
console.log(`\n完成：新增 ${insertedSessions} 个会话 / ${insertedMessages} 条消息`);
console.log(`库内合计：${summary.rows[0].sessions} 会话 / ${summary.rows[0].messages} 消息`);

await client.end();
