/**
 * 记忆整理：导出成 CSV / 改完导回去
 * ============================================================================
 * 比一行行敲命令快得多：导出一个表，用 Excel 或记事本一条条看，
 *   keep=0  → 删掉
 *   date    → 补日期（YYYY-MM-DD）
 *   content → 想改就改（留空或不动就不改）
 * 然后导入，一次性生效。
 *
 * 用法（在 /opt/opencns/server 下，或者直接用 tidy 命令）：
 *
 *   node scripts/memory-review.js export
 *   node scripts/memory-review.js export --filter=no_time
 *   node scripts/memory-review.js import /root/memory-review.csv --dry
 *   node scripts/memory-review.js import /root/memory-review.csv --yes
 */

import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(HERE, '../.env'), quiet: true });

const { many, query, closePool } = await import('../build/db/pool.js');

const cmd = process.argv[2] ?? 'export';
const args = {};
for (const a of process.argv.slice(3)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) args[m[1]] = m[2] === undefined ? true : m[2];
}
const positional = process.argv.slice(3).filter((a) => !a.startsWith('--'));

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
};

/**
 * Date -> YYYY-MM-DD（按 +08 算）
 * 踩过：直接 String(date).slice(0,10) 会得到 "Mon Jun 22"。
 */
function ymd(v) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

/** 极简 CSV 解析（支持引号、转义、换行） */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  const t = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inQuotes) {
      if (c === '"') {
        if (t[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else cell += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c === '\r') { /* skip */ }
    else cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r[0] ?? '').trim() !== '');
}

async function doExport() {
  const filter = args.filter ?? 'all';
  const where = [`state = 'active'`, `pinned = false`];
  if (filter === 'no_time') where.push('event_time is null');
  if (filter === 'third') where.push(`(content like '%林遇%' or content like '%江瑜%')`);

  const rows = await many(
    `select id::text, kind, coalesce(provenance->>'source','(无)') as source,
            event_time, ingested_at, content
       from memory_items
      where ${where.join(' and ')}
      order by
        case coalesce(provenance->>'source','')
          when 'compressor' then 1 when 'ltm_v13' then 2 else 3 end,
        event_time nulls last, ingested_at desc`,
  );

  const out = process.env.OUT || '/root/memory-review.csv';
  const head = ['id', 'keep', 'date', 'kind', 'source', 'content'];
  const lines = [head.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.id,
        '1',
        ymd(r.event_time),
        r.kind,
        r.source,
        csvCell(r.content),
      ].join(','),
    );
  }

  // BOM 让 Excel 正确识别 UTF-8
  fs.writeFileSync(out, `\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
  console.log(`  导出 ${rows.length} 条 -> ${out}`);
  console.log('  说明：keep 改成 0 就是删掉；date 填 YYYY-MM-DD 就补日期；content 想改就改。');
}

async function doImport() {
  const file = positional[0];
  if (!file || !fs.existsSync(file)) {
    console.log('  用法：import <csv 路径> [--dry] [--yes]');
    return;
  }
  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  const head = rows.shift();
  const idx = Object.fromEntries(head.map((h, i) => [String(h).trim().toLowerCase(), i]));
  if (idx.id === undefined) {
    console.log('  表头里没有 id 列，看不懂这个文件');
    return;
  }

  const isDry = Boolean(args.dry);
  let toPrune = 0;
  let toDate = 0;
  let toEdit = 0;
  const problems = [];
  const seen = new Set();

  for (const r of rows) {
    const id = (r[idx.id] ?? '').trim();
    if (!id) continue;
    seen.add(id);

    const keep = String(r[idx.keep] ?? '1').trim().toLowerCase();
    const date = (r[idx.date] ?? '').trim();
    const content = r[idx.content] ?? '';

    const cur = await many(
      `select id::text, content, event_time from memory_items where id = $1`,
      [id],
    );
    if (cur.length === 0) { problems.push(`找不到 ${id.slice(0, 8)}`); continue; }
    const row = cur[0];

    if (['0', 'n', 'no', 'x', '删', 'false'].includes(keep)) {
      if (!isDry) {
        await query(`update memory_items set state = 'pruned' where id = $1 and pinned = false`, [id]);
      }
      toPrune++;
      continue;
    }

    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const curDate = ymd(row.event_time);
      if (curDate !== date) {
        if (!isDry) {
          await query(
            `update memory_items set event_time = $2, event_time_precision = 'exact' where id = $1`,
            [id, new Date(date).toISOString()],
          );
        }
        toDate++;
      }
    } else if (date) {
      problems.push(`${id.slice(0, 8)} 的日期格式不对：${date}`);
    }

    const newContent = String(content);
    if (newContent && newContent !== String(row.content)) {
      if (!isDry) {
        await query(`update memory_items set content = $2 where id = $1`, [id, newContent]);
      }
      toEdit++;
    }
  }

  /*
   * --sync：文件里**没有**的，按删除处理。
   *
   * 为什么要它：在 Excel 里直接删行比把 keep 改成 0 顺手得多，
   * 但删掉的行不会出现在文件里，导入时无从知道"这条被删了"。
   * 所以用"导出时的全集 - 文件里剩下的" = 要删的。
   */
  let toSyncPrune = 0;
  if (args.sync) {
    const living = await many(
      `select id::text from memory_items
        where state = 'active' and pinned = false`,
    );
    const missing = living.filter((x) => !seen.has(x.id));
    // 安全阀：如果文件小得离谱，多半是导错了文件，不干
    if (living.length > 0 && seen.size < living.length * 0.1) {
      console.log(`  !! 文件里只有 ${seen.size} 条，库里活着 ${living.length} 条，差太多，拒绝同步。`);
      console.log('     请确认导出的是全部（export 不带 --filter）。');
      return;
    }
    toSyncPrune = missing.length;
    if (!isDry && args.yes) {
      for (const m of missing) {
        await query(`update memory_items set state = 'pruned' where id = $1 and pinned = false`, [m.id]);
      }
    }
  }

  console.log(`  规则：${rows.length} 行`);
  console.log(`  要删：${toPrune}   补日期：${toDate}   改正文：${toEdit}`);
  if (args.sync) {
    console.log(`  同步删（文件里没有的）：${toSyncPrune}`);
  }
  if (problems.length) {
    console.log('  有问题的那几行：');
    for (const p of problems.slice(0, 10)) console.log(`    · ${p}`);
    if (problems.length > 10) console.log(`    …共 ${problems.length} 条`);
  }
  if (isDry) console.log('  （--dry：只是演练，什么都没改）');
  else if (!args.yes) console.log('  加 --yes 才会真的写进去');
  else console.log('  已写进去');
}

try {
  if (cmd === 'export') await doExport();
  else if (cmd === 'import') await doImport();
  else console.log('  可用：export / import <csv>');
} catch (err) {
  console.error('  出错：', err.message);
  process.exitCode = 1;
} finally {
  await closePool().catch(() => {});
}
