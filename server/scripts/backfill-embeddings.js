#!/usr/bin/env node
/**
 * 回填向量：把所有 embedding 为空的记忆用 bge-m3 重新算一遍。
 *
 * 为什么必须做：旧库是 768 维（nomic-embed-text），v2 的列是 1024 维（bge-m3），
 * 新旧向量不可比，所以迁移时刻意留空。没有向量就没有语义召回。
 *
 * 幂等：只处理 embedding is null 的行，可随时中断重跑。
 * 内存：bge-m3 载入约 1.5GB，跑完靠 keep_alive 自动卸载。
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

const env = loadEnv('/opt/opencns/server/.env');
const DB_URL = env.DATABASE_URL;
const OLLAMA = (env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
const MODEL = env.EMBEDDING_MODEL ?? 'bge-m3';
const DIM = Number(env.EMBEDDING_DIM ?? 1024);
const BATCH = 32;

if (!DB_URL) {
  console.error('读不到 DATABASE_URL');
  process.exit(2);
}

const client = new pg.Client({ connectionString: DB_URL });
await client.connect();

const { rows: before } = await client.query(
  `select count(*)::int as total, count(embedding)::int as done from memory_items`,
);
console.log(`库内记忆 ${before.total} 条，已有向量 ${before.done} 条，待处理 ${before.total - before.done} 条`);

let processed = 0;
let failed = 0;
const started = Date.now();

for (;;) {
  const { rows } = await client.query(
    `select id, left(content, 2000) as text from memory_items where embedding is null order by ingested_at limit $1`,
    [BATCH],
  );
  if (rows.length === 0) break;

  const inputs = rows.map((r) => r.text ?? '');
  let embeddings;
  try {
    const res = await fetch(`${OLLAMA}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, input: inputs, keep_alive: '10m' }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    embeddings = json.embeddings;
  } catch (err) {
    console.error(`批次失败（${rows.length} 条）：${err.message}`);
    failed += rows.length;
    // 防止死循环：把这一批标记为已尝试过（用零向量占位不合适，所以直接跳出并提示）
    console.error('为避免无限重试，本轮中止。修好 embedding 服务后重跑即可。');
    break;
  }

  if (!Array.isArray(embeddings) || embeddings.length !== rows.length) {
    console.error(`返回条数不符：期望 ${rows.length}，得到 ${embeddings?.length}`);
    failed += rows.length;
    break;
  }

  for (let i = 0; i < rows.length; i++) {
    const vec = embeddings[i];
    if (!Array.isArray(vec) || vec.length !== DIM) {
      console.error(`维度不符：期望 ${DIM}，得到 ${vec?.length}`);
      failed++;
      continue;
    }
    await client.query(`update memory_items set embedding = $2::vector where id = $1`, [
      rows[i].id,
      `[${vec.join(',')}]`,
    ]);
    processed++;
  }

  const secs = ((Date.now() - started) / 1000).toFixed(0);
  console.log(`已回填 ${processed} 条（失败 ${failed}）  用时 ${secs}s`);
}

const { rows: after } = await client.query(
  `select count(*)::int as total, count(embedding)::int as done from memory_items`,
);
console.log(`\n完成：${after.done}/${after.total} 条有向量，失败 ${failed} 条`);

const { rows: sanity } = await client.query(
  `select vector_dims(embedding) as dim, count(*)::int as n from memory_items where embedding is not null group by 1`,
);
console.log('维度分布：', sanity.map((r) => `${r.dim}维×${r.n}`).join(', '));

await client.end();
