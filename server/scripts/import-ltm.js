/**
 * LTM_v13 → 记忆库（只补缺的）
 *
 * 为什么要拆条目：LTM 是一份"档案"，一条 bullet 就是一件独立的事实
 * （颈椎没去看、黑糖珍珠少冰、大熊是橙子的花店合伙人）。
 * 整份塞进去既是垃圾召回源，也会让时间树失真。
 *
 * 去重是两层：
 *   1) 向量余弦 —— 语义上已经有的，跳过
 *   2) trigram 词相似 —— 长日记里已经写了这个事实的，跳过
 * 两层任一命中都不插。每个跳过都会打印原因和最近的那条已有记忆，便于复核。
 *
 * 用法（在 /opt/opencns/server 下）：
 *   node scripts/import-ltm.js /root/LTM_v13.md [--dry]
 */

import { readFileSync } from 'node:fs';
import { many, one, query, closePool } from '../build/db/pool.js';
import { getEmbeddingProvider } from '../build/embedding/index.js';

const file = process.argv[2] ?? '/root/LTM_v13.md';
const dry = process.argv.includes('--dry');

const SOURCE = 'ltm_v13';
const IMPORTANCE = 0.75;
/** 向量余弦 >= 这个值就认为"已经有了"（抓同义改写） */
const SIM_SKIP = 0.88;
/** 一条已有记忆里命中多少比例的词，就认为"这件事已经写过了" */
const HIT_RATIO_SKIP = 0.5;
/** 至少命中几个词才算重复（防止短条目误判） */
const HIT_MIN = 3;

/**
 * 抽词：中文 2-gram + 整词 + 英数串。
 *
 * 为什么不用余弦相似度做主判据：一条 bullet 是几十字的事实，已有记忆是
 * 三五百字的日记。这种长度差下余弦天然只有 0.5~0.7，即使这个事实明明写在里面。
 * 而"这条事实的关键词是否在同一条已有记忆里一起出现过"才真正对得上。
 */
function tokensOf(text) {
  const set = new Set();
  for (const run of text.split(/[^\u4e00-\u9fa5]+/)) {
    if (run.length >= 3) set.add(run);
    for (let i = 0; i + 2 <= run.length; i++) set.add(run.slice(i, i + 2));
  }
  for (const m of text.matchAll(/[A-Za-z]{2,}|\d{2,}/g)) set.add(m[0]);
  return [...set].slice(0, 24);
}

// ─────────────────────────── 解析 ───────────────────────────

/** @typedef {{ section: string, text: string, line: number }} Item */

function parseLtm(md) {
  const lines = md.split(/\r?\n/);
  /** @type {Item[]} */
  const items = [];
  let section = '';
  let buf = null; // { text, line }

  const flush = () => {
    if (buf && buf.text.trim()) {
      items.push({ section, text: buf.text.trim(), line: buf.line });
    }
    buf = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trimEnd();
    const t = line.trim();

    if (!t) {
      flush();
      continue;
    }
    // 标题：更新 section，结束当前条目
    const h = /^##\s+(.*)$/.exec(t);
    if (h) {
      flush();
      section = h[1].trim();
      continue;
    }
    // 一级标题/引用/分隔线：忽略
    if (/^#\s/.test(t) || t.startsWith('>') || /^-{3,}$/.test(t)) {
      flush();
      continue;
    }

    // bullet：新条目
    const b = /^[-*]\s+(.*)$/.exec(t);
    if (b) {
      flush();
      buf = { text: b[1], line: i + 1 };
      continue;
    }

    // 加粗键值行：**姓名：** 林遇
    const kv = /^\*\*(.+?)[：:]\*\*\s*(.*)$/.exec(t);
    if (kv) {
      flush();
      const combined = `${kv[1].trim()}：${kv[2].trim()}`;
      buf = { text: combined, line: i + 1 };
      continue;
    }

    // 缩进的续行：并进当前条目
    if (buf && /^\s{2,}/.test(line)) {
      buf.text += t;
      continue;
    }

    // 其它裸行：当成新条目
    flush();
    buf = { text: t, line: i + 1 };
  }
  flush();

  // 过滤：太短、纯标题性内容
  return items.filter((it) => it.text.replace(/\*\*/g, '').trim().length >= 10);
}

/** 从条目里猜事件日期（LTM 内容全部是 2026 年） */
function guessEventTime(text) {
  const year = 2026;
  const md = /(\d{1,2})月(\d{1,2})[日号]/.exec(text);
  if (md) {
    const m = Number(md[1]);
    const d = Number(md[2]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return { eventTime: `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T00:00:00+08:00`, precision: 'day' };
    }
  }
  const sl = /(?<!\d)(\d{1,2})\/(\d{1,2})(?!\d)/.exec(text);
  if (sl) {
    const m = Number(sl[1]);
    const d = Number(sl[2]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return { eventTime: `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T00:00:00+08:00`, precision: 'day' };
    }
  }
  return { eventTime: null, precision: 'unknown' };
}

// ─────────────────────────── 主流程 ───────────────────────────

const md = readFileSync(file, 'utf8');
const items = parseLtm(md);
const embedded = items.map((it) => ({ ...it, text: it.text.replace(/\*\*/g, '').trim() }));

console.log(`解析出 ${embedded.length} 条待判定条目${dry ? '（演练模式，不写库）' : ''}\n`);

const provider = getEmbeddingProvider();
console.log(`embedding: ${provider.name}\n`);

const BATCH = 8;
let imported = 0;
let skippedSim = 0;
let skippedTrgm = 0;
const report = [];

for (let i = 0; i < embedded.length; i += BATCH) {
  const chunk = embedded.slice(i, i + BATCH);
  const vecs = await provider.embed(chunk.map((c) => c.text));

  for (let k = 0; k < chunk.length; k++) {
    const it = chunk[k];
    const vec = vecs[k];
    if (!Array.isArray(vec) || vec.length === 0) {
      console.log(`  ! 向量失败，跳过：${it.text.slice(0, 40)}`);
      continue;
    }
    const lit = `[${vec.join(',')}]`;

    const near = await one(
      `select id, content, 1 - (embedding <=> $1::vector) as sim
         from memory_items
        where embedding is not null and state in ('active','archived')
        order by embedding <=> $1::vector
        limit 1`,
      [lit],
    );

    if (near && Number(near.sim) >= SIM_SKIP) {
      skippedSim++;
      report.push({ why: '语义重复', score: Number(near.sim).toFixed(3), text: it.text, existing: near.content });
      continue;
    }

    // 主判据：关键词共现
    const tokens = tokensOf(it.text);
    const need = Math.max(HIT_MIN, Math.ceil(tokens.length * HIT_RATIO_SKIP));
    const patterns = tokens.map((t) => `%${t}%`);
    const hit = await one(
      `select id, content, hits from (
         select id, content,
                (select count(*) from unnest($1::text[]) tok
                  where content ilike '%' || tok || '%') as hits
           from memory_items
          where state in ('active','archived')
            and content ilike any($2::text[])
        ) t
       order by hits desc
       limit 1`,
      [tokens, patterns],
    );

    if (hit && Number(hit.hits) >= need) {
      skippedTrgm++;
      report.push({
        why: '关键词已写过',
        score: `${hit.hits}/${tokens.length}`,
        text: it.text,
        existing: hit.content,
      });
      continue;
    }

    if (dry) {
      imported++;
      continue;
    }

    const { eventTime, precision } = guessEventTime(it.text);
    await query(
      `insert into memory_items (
         kind, origin, subject, content, quotes, causal,
         event_time, event_time_precision, ingested_at,
         privacy, state, importance, decay_score, embedding, provenance
       ) values (
         'semantic', 'self', 'user', $1, '[]'::jsonb, null,
         $2, $3, now(),
         'private', 'active', $4, 1.0, $5::vector, $6::jsonb
       )`,
      [
        it.text,
        eventTime,
        precision,
        IMPORTANCE,
        lit,
        JSON.stringify({ source: SOURCE, section: it.section, line: it.line }),
      ],
    );
    imported++;
    console.log(`  + ${it.text.slice(0, 46)}${it.text.length > 46 ? '…' : ''}`);
  }
}

console.log('\n──────────────── 复核：被跳过的条目 ────────────────');
for (const r of report) {
  console.log(`\n[${r.why} ${r.score}] ${r.text.slice(0, 70)}`);
  console.log(`    已有：${String(r.existing).replace(/\s+/g, ' ').slice(0, 80)}…`);
}

const after = await one(
  `select count(*)::int as total,
          count(*) filter (where provenance->>'source' = $1)::int as from_ltm
     from memory_items`,
  [SOURCE],
);

console.log('\n──────────────── 结果 ────────────────');
console.log(`新增 ${imported} 条 · 语义重复跳过 ${skippedSim} 条 · 词面重复跳过 ${skippedTrgm} 条`);
console.log(`库内总计 ${after.total} 条（其中来自 LTM 的 ${after.from_ltm} 条）`);
if (imported > 0 && !dry) {
  console.log('\n注意：这些记忆的 embedding 已在插入时写好，不需要再跑 backfill。');
}

await closePool();
