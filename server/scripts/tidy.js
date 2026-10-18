/**
 * 记忆整理工具（跑在服务器上）
 * ============================================================================
 * 用法（先 cd /opt/opencns/server）：
 *
 *   node scripts/tidy.js stats
 *   node scripts/tidy.js list --filter=no_time --limit=15
 *   node scripts/tidy.js list --filter=third --limit=15
 *   node scripts/tidy.js show --id=274b7ed9
 *
 *   node scripts/tidy.js delete --id=274b7ed9 --yes
 *   node scripts/tidy.js delete --source=compressor --yes
 *   node scripts/tidy.js delete --kind=reflection --yes
 *
 *   node scripts/tidy.js date --id=274b7ed9 --day=2026-07-17
 *   node scripts/tidy.js date --source=ltm_v13 --day=2026-07-01      # 整批补
 *
 *   node scripts/tidy.js persona            # 看人格底座
 *   node scripts/tidy.js purge-persona --yes  # 把记忆库里残留的人格种子摘掉
 *
 * 说明：删除是**软删**（state = pruned）。不再被召回、不再上星图，
 * 但数据还在库里；想恢复：
 *   node scripts/tidy.js restore --id=xxx
 */

import { many, one, query, closePool } from '../build/db/pool.js';

const args = {};
for (const a of process.argv.slice(3)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) args[m[1]] = m[2] === undefined ? true : m[2];
}
const cmd = process.argv[2] ?? 'stats';

const n = (v) => Number(v ?? 0).toLocaleString('en-US');
const short = (s, w = 62) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > w ? `${t.slice(0, w)}…` : t;
};
const needYes = () => {
  if (!args.yes) {
    console.log('\n这是破坏性操作。确认了就在命令末尾加 --yes 再跑一次。');
    process.exit(1);
  }
};

async function stats() {
  const r = await one(`
    select count(*)::int as total,
           count(*) filter (where state = 'active')::int as active,
           count(*) filter (where state = 'pruned')::int as pruned,
           count(*) filter (where state = 'active' and event_time is null)::int as no_time,
           count(*) filter (where state = 'active' and (content like '%林遇%' or content like '%江瑜%'))::int as third,
           count(*) filter (where pinned)::int as pinned
      from memory_items`);
  const bySource = await many(`
    select coalesce(provenance->>'source', '(无)') as source, count(*)::int as n
      from memory_items where state = 'active' and pinned = false
     group by 1 order by 2 desc`);
  const byKind = await many(`
    select kind, count(*)::int as n from memory_items
     where state = 'active' and pinned = false group by 1 order by 2 desc`);

  console.log('\n  记忆库现状');
  console.log('  ─────────────────────────');
  console.log(`  总计        ${n(r.total)}`);
  console.log(`  活着        ${n(r.active)}`);
  console.log(`  已摘掉      ${n(r.pruned)}`);
  console.log(`  没日期      ${n(r.no_time)}`);
  console.log(`  第三人称    ${n(r.third)}`);
  console.log(`  钉住(底座)  ${n(r.pinned)}`);
  console.log('\n  按来源');
  for (const s of bySource) console.log(`    ${s.source.padEnd(14)} ${n(s.n)}`);
  console.log('\n  按类型');
  for (const k of byKind) console.log(`    ${k.kind.padEnd(14)} ${n(k.n)}`);
  console.log('');
}

function whereOf() {
  const w = [`state = 'active'`, `pinned = false`];
  const p = [];
  const filter = args.filter ?? 'all';
  if (filter === 'no_time') w.push('event_time is null');
  else if (filter === 'third') w.push(`(content like '%林遇%' or content like '%江瑜%')`);
  if (args.source) {
    p.push(args.source);
    w.push(`provenance->>'source' = $${p.length}`);
  }
  if (args.kind) {
    p.push(args.kind);
    w.push(`kind = $${p.length}`);
  }
  return { sql: w.join(' and '), params: p };
}

async function list() {
  const { sql, params } = whereOf();
  const limit = Math.min(100, Number(args.limit ?? 15));
  const rows = await many(
    `select id::text, kind, coalesce(provenance->>'source','(无)') as source,
            event_time, pinned, content
       from memory_items where ${sql}
      order by ingested_at desc limit ${limit}`,
    params,
  );
  console.log(`\n  共 ${rows.length} 条（--limit 可调）\n`);
  for (const r of rows) {
    const when = r.event_time ? String(r.event_time).slice(0, 10) : '没有日期';
    const third = /林遇|江瑜/.test(r.content) ? ' [第三人称]' : '';
    console.log(`  ${r.id.slice(0, 8)}  ${when.padEnd(10)}  ${r.kind.padEnd(10)} ${r.source}${third}`);
    console.log(`            ${short(r.content)}`);
  }
  console.log('');
}

async function show() {
  if (!args.id) return console.log('要 --id=xxx');
  const r = await one(
    `select id::text, kind, origin, subject, content, quotes, causal, event_time,
            coalesce(provenance->>'source','(无)') as source, importance, pinned, state
       from memory_items where id::text like $1 limit 1`,
    [`${args.id}%`],
  );
  if (!r) return console.log('没找到');
  console.log('\n  id      ', r.id);
  console.log('  类型    ', r.kind, '| 来源', r.source, '| 状态', r.state, r.pinned ? '| 钉住' : '');
  console.log('  日期    ', r.event_time ? String(r.event_time).slice(0, 10) : '没有日期');
  console.log('  正文    ', r.content);
  if (r.quotes && String(r.quotes) !== '[]') console.log('  原句    ', JSON.stringify(r.quotes));
  if (r.causal) console.log('  因果    ', r.causal);
  console.log('');
}

async function del() {
  needYes();
  if (args.id) {
    const r = await one(
      `update memory_items set state = 'pruned'
        where id::text like $1 and pinned = false returning id::text`,
      [`${args.id}%`],
    );
    return console.log(r ? `  已摘掉 ${r.id.slice(0, 8)}` : '  没找到（或者是钉住的底座）');
  }
  if (!args.source && !args.kind) {
    return console.log('  要 --id / --source / --kind 之一');
  }
  const { sql, params } = whereOf();
  const rows = await many(
    `update memory_items set state = 'pruned' where ${sql} returning id::text`,
    params,
  );
  console.log(`  已摘掉 ${rows.length} 条`);
}

async function setDate() {
  if (!args.day) return console.log('要 --day=YYYY-MM-DD');
  const d = new Date(args.day);
  if (Number.isNaN(d.getTime())) return console.log('日期看不懂');
  const iso = d.toISOString();
  if (args.id) {
    const r = await one(
      `update memory_items set event_time = $2, event_time_precision = 'exact'
        where id::text like $1 returning id::text`,
      [`${args.id}%`, iso],
    );
    return console.log(r ? `  已补 ${r.id.slice(0, 8)} → ${args.day}` : '  没找到');
  }
  const { sql, params } = whereOf();
  const rows = await many(
    `update memory_items set event_time = $${params.length + 1}, event_time_precision = 'exact'
      where ${sql} and event_time is null returning id::text`,
    [...params, iso],
  );
  console.log(`  已给 ${rows.length} 条补上 ${args.day}`);
}

async function restore() {
  if (!args.id) return console.log('要 --id=xxx');
  const r = await one(
    `update memory_items set state = 'active' where id::text like $1 returning id::text`,
    [`${args.id}%`],
  );
  console.log(r ? `  已恢复 ${r.id.slice(0, 8)}` : '  没找到');
}

async function persona() {
  const rows = await many(
    `select id::text, title, body, section, sort, active from persona order by sort asc`,
  );
  console.log(`\n  人格底座 ${rows.length} 条（始终在系统提示词里，不进记忆库）\n`);
  for (const p of rows) {
    console.log(`  ${p.id.slice(0, 8)}  [${p.section}] ${p.title}${p.active ? '' : ' (停用)'}`);
    console.log(`            ${short(p.body, 70)}`);
  }
  console.log('');
}

async function purgePersona() {
  needYes();
  const rows = await many(
    `update memory_items set state = 'pruned'
      where provenance->>'source' like 'persona_seed%' and state = 'active'
      returning id::text`,
  );
  console.log(`  记忆库里摘掉了 ${rows.length} 条人格种子（原文已经在 persona 表）`);
}

const table = { stats, list, show, delete: del, date: setDate, restore, persona, 'purge-persona': purgePersona };
const fn = table[cmd];
if (!fn) {
  console.log(`  不认识的命令：${cmd}`);
  console.log('  可用：stats / list / show / delete / date / restore / persona / purge-persona');
  process.exit(1);
}
try {
  await fn();
} catch (err) {
  console.error('  出错：', err.message);
  process.exitCode = 1;
} finally {
  await closePool().catch(() => {});
}
