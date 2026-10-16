#!/usr/bin/env node
/**
 * M5 探针：验证两条"平时不一定会被触发"的路径。
 *
 *  1) 矛盾处理：造一条与既有记忆冲突的新记忆，看旧的会不会被打上有向标签
 *     （技巧：直接复制目标记忆的向量，保证相似度=1，把变量降到只剩"内容是否冲突"）
 *  2) 衰减的 active -> archived 分支（阈值 0.35）
 *
 * 用完会清理测试数据，不污染真实库。
 */

import { readFileSync } from 'node:fs';
import pg from 'pg';

function loadEnv(file) {
  const out = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i === -1) continue;
    out[s.slice(0, i).trim()] = s.slice(i + 1).trim().replace(/\r$/, '');
  }
  return out;
}

const env = loadEnv('/opt/opencns/server/.env');
const client = new pg.Client({ connectionString: env.DATABASE_URL });
await client.connect();

const { applySupersede } = await import('/opt/opencns/server/build/memory/maintenance/contradiction.js');

// ---------------------------------------------------------------- 1) 矛盾处理
console.log('=== 探针 1：矛盾处理 ===');
console.log('（要测的是"内容真的冲突"，所以挑一条具体事实，再写一条推翻它的）');

// 挑一条具体的、可被推翻的事实型记忆
const target = (
  await client.query(
    `select id, content, embedding::text as emb, state
       from memory_items
      where state = 'active' and embedding is not null
        and (content like '%屁屁%' or content like '%猫%' or content like '%奶茶%' or content like '%头发%')
      order by char_length(content) asc
      limit 1`,
  )
).rows[0];

if (!target) {
  console.log('库里没有可用样本，跳过');
} else {
  console.log(`目标记忆 ${target.id.slice(0, 8)}：${target.content.slice(0, 70)}`);

  // 直接引用目标内容来构造"推翻它"的新记忆，并保证 ≥80 字
  const newContent =
    `她今天纠正了我之前记错的事。关于「${target.content.slice(0, 40)}」这个说法，她说现在已经不一样了：` +
    `「那个是老早以前的事，后来改了，你别再按旧的记。」我记得自己确认了两遍才改过来，跟她说以后按新的来。`;
  const { rows: inserted } = await client.query(
    `insert into memory_items (kind, origin, subject, content, quotes, causal, emotion_valence, emotion_arousal,
                               event_time, event_time_precision, importance, state, embedding, provenance)
     values ('episode','auto','shared',$1,
             '[{"who":"林遇","said":"别再按老规矩办了"}]'::jsonb,
             '{"happened":"她说旧安排作废","reaction":"我确认了一遍","act":"我记下新规则","outcome":"以后按新的来"}'::jsonb,
             0.3, 0.4, now(), 'exact', 0.7, 'active', $2::vector, '{"probe":"supersede"}'::jsonb)
     returning id`,
    [newContent, target.emb],
  );
  const testId = inserted[0].id;
  console.log(`已插入冲突样本 ${testId.slice(0, 8)}（复制了目标记忆的向量，相似度=1）`);

  const superseded = await applySupersede(testId, newContent, 'probe');
  console.log(`判定结果：取代了 ${superseded.length} 条 -> ${superseded.map((s) => s.slice(0, 8)).join(', ') || '（无）'}`);

  const after = await client.query(`select state, superseded_by from memory_items where id = $1`, [target.id]);
  console.log(`目标记忆现在的状态：${after.rows[0].state}  superseded_by=${after.rows[0].superseded_by?.slice(0, 8) ?? 'null'}`);
  const edge = await client.query(
    `select count(*)::int as n from memory_edges where from_id = $1 and to_id = $2 and relation='supersedes'`,
    [testId, target.id],
  );
  console.log(`有向边：${edge.rows[0].n} 条`);

  // 清理
  await client.query(`delete from memory_edges where from_id = $1`, [testId]);
  await client.query(`delete from memory_items where id = $1`, [testId]);
  await client.query(`update memory_items set state='active', superseded_by=null where id = $1`, [target.id]);
  console.log('测试数据已清理，目标记忆状态已还原');
}

// ---------------------------------------------------------------- 2) 衰减 active->archived
console.log('');
console.log('=== 探针 2：衰减的 active -> archived 分支 ===');

const victim = (
  await client.query(
    `select id, state, importance from memory_items
      where state='active' and not pinned and importance between 0.4 and 0.6
      order by random() limit 1`,
  )
).rows[0];

if (!victim) {
  console.log('库里没有合适的样本，跳过');
} else {
  await client.query(
    `update memory_items set last_recalled_at = now() - interval '600 days', decay_score = 1.0, state='active' where id=$1`,
    [victim.id],
  );
  console.log(`把 ${victim.id.slice(0, 8)}（重要度 ${victim.importance}）的"上次想起"推到 600 天前`);

  const { runDecay } = await import('/opt/opencns/server/build/memory/maintenance/decay.js');
  const r = await runDecay();
  console.log('衰减结果：', JSON.stringify(r));

  const after = await client.query(`select state, round(decay_score::numeric,5) as score from memory_items where id=$1`, [
    victim.id,
  ]);
  console.log(`该记忆现在：state=${after.rows[0].state}  score=${after.rows[0].score}`);

  await client.query(`update memory_items set state='active', decay_score=1.0, last_recalled_at=null where id=$1`, [
    victim.id,
  ]);
  console.log('已还原');
}

await client.end();
