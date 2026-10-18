/**
 * 把「对话摘录」一条条补进记忆库。
 *
 * 用法（在 /opt/opencns/server 下）：
 *   node scripts/import-excerpt.js /root/excerpt-items.json              # 导入（有日期的带日期）
 *   node scripts/import-excerpt.js --export-undated=/root/excerpt-undated.csv
 *   node scripts/import-excerpt.js --apply-dates=/root/excerpt-undated.csv --yes
 *
 * 设计：
 *   · 一条摘录 = 一条记忆（kind=semantic，subject=user，importance 0.6）
 *   · 用 provenance.excerpt_n 编号去重，重复跑不会插两份
 *   · 没有日期的先导进去（event_time 为空），之后用 CSV 补
 */

import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(HERE, '../.env'), quiet: true });

const { many, one, query, closePool } = await import('../build/db/pool.js');
const { embedOne } = await import('../build/embedding/index.js');

const args = process.argv.slice(2);
const flag = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const SOURCE = 'excerpt_v8';

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function doImport(jsonPath) {
  if (!jsonPath || !fs.existsSync(jsonPath)) {
    console.log('  用法：import-excerpt.js <excerpt-items.json>');
    return;
  }
  const items = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const existing = await many(
    `select (provenance->>'excerpt_n')::int as n from memory_items
      where provenance->>'source' = $1 and provenance ? 'excerpt_n'`,
    [SOURCE],
  );
  const seen = new Set(existing.map((r) => Number(r.n)));

  let added = 0;
  let skipped = 0;
  let dated = 0;
  for (const it of items) {
    if (seen.has(it.n)) { skipped++; continue; }

    let vec = null;
    try {
      vec = `[${(await embedOne(it.content.slice(0, 2000))).join(',')}]`;
    } catch {
      /* 没有向量也能存 */
    }

    await query(
      `insert into memory_items (
         kind, origin, subject, content, quotes, causal,
         event_time, event_time_precision, ingested_at,
         privacy, state, importance, decay_score, embedding, provenance
       ) values (
         'semantic', 'auto', 'user', $1, $2::jsonb, null,
         $3, $4, now(),
         'private', 'active', 0.6, 1.0, $5::vector, $6::jsonb
       )`,
      [
        it.content,
        JSON.stringify(it.quotes ?? []),
        it.eventTime ? new Date(`${it.eventTime}T12:00:00+08:00`).toISOString() : null,
        it.eventTime ? 'exact' : 'unknown',
        vec,
        JSON.stringify({ source: SOURCE, excerpt_n: it.n, section: it.section, title: it.title }),
      ],
    );
    added++;
    if (it.eventTime) dated++;
  }

  console.log(`  共 ${items.length} 条：新增 ${added}（其中带日期 ${dated}），已存在跳过 ${skipped}`);
}

async function doExportUndated(outPath) {
  if (!outPath) return;
  const rows = await many(
    `select (provenance->>'excerpt_n')::int as n,
            provenance->>'section' as section,
            content, event_time
       from memory_items
      where provenance->>'source' = $1 and event_time is null and state = 'active'
      order by n`,
    [SOURCE],
  );
  const lines = ['n,date,content'];
  for (const r of rows) lines.push([r.n, '', csvCell(r.content)].join(','));
  fs.writeFileSync(outPath, `\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
  console.log(`  无日期的 ${rows.length} 条已导出 -> ${outPath}`);
  console.log('  填好 date 列（YYYY-MM-DD）再传回来：');
  console.log(`    node scripts/import-excerpt.js --apply-dates=${outPath} --yes`);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  const t = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.length > 1);
}

async function doApplyDates(file, apply) {
  if (!file || !fs.existsSync(file)) return;
  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  const head = rows.shift().map((h) => h.trim().toLowerCase());
  const iN = head.indexOf('n');
  const iD = head.indexOf('date');
  if (iN < 0 || iD < 0) { console.log('  表头要有 n 和 date'); return; }

  let filled = 0;
  let bad = 0;
  const misses = [];
  for (const r of rows) {
    const n = Number(String(r[iN] ?? '').trim());
    let d = String(r[iD] ?? '').trim();
    if (!n || !d) continue;
    const m = /^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/.exec(d);
    if (!m) { bad++; misses.push(`${n}: ${d}`); continue; }
    d = `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
    if (apply) {
      await query(
        `update memory_items
            set event_time = $2, event_time_precision = 'exact'
          where provenance->>'source' = $1 and (provenance->>'excerpt_n')::int = $3`,
        [SOURCE, new Date(`${d}T12:00:00+08:00`).toISOString(), n],
      );
    }
    filled++;
  }
  console.log(`  读到 ${filled} 条有日期的${bad ? `，${bad} 条格式不对` : ''}`);
  for (const m of misses.slice(0, 5)) console.log(`    格式不对: ${m}`);
  console.log(apply ? '  已写入' : '  演练中（加 --yes 才写）');
}

try {
  const exportPath = flag('export-undated');
  const applyPath = flag('apply-dates');
  if (applyPath) {
    await doApplyDates(applyPath, args.includes('--yes'));
  } else {
    const jsonPath = args.find((a) => !a.startsWith('--'));
    await doImport(jsonPath);
    if (exportPath) await doExportUndated(exportPath);
  }
} catch (err) {
  console.error('  出错：', err.message);
  process.exitCode = 1;
} finally {
  await closePool().catch(() => {});
}
