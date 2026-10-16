#!/usr/bin/env node
/**
 * 旧库 804 条记忆 -> v2 memory_items 的迁移器。
 *
 * 设计要点
 *  - 零依赖（只用 node 内置模块），服务器上直接 node 运行，不需要 npm install。
 *  - 默认 dry-run：只做对账、生成 SQL 文件，不碰数据库。加 --apply 才执行。
 *  - 幂等：以 legacy_id 为键（0001 里已建唯一索引），重复执行只会撞 ON CONFLICT。
 *  - 向量一律留空：768 -> 1024 不可比，迁移后统一用 bge-m3 重算。
 *  - 旧数据一律 migrated_legacy=true，它们全是第三人称"档案"，不是情景记忆。
 *
 * 用法
 *   node migrate-legacy.js <legacy-memories.json> [--apply] [--out /root/legacy-migration.sql]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const jsonPath = args.find((a) => !a.startsWith('--')) ?? '/root/legacy-memories.json';
const APPLY = args.includes('--apply');
const outIdx = args.indexOf('--out');
const outPath = outIdx !== -1 ? args[outIdx + 1] : '/root/legacy-migration.sql';

const raw = JSON.parse(readFileSync(jsonPath, 'utf8'));

// ---------------------------------------------------------------- 工具
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const jsonb = (v) => `${q(JSON.stringify(v ?? null))}::jsonb`;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : null);
const arr = (a) =>
  Array.isArray(a) && a.length
    ? `ARRAY[${a.map((x) => q(String(x))).join(',')}]::text[]`
    : `'{}'::text[]`;

const norm = (s) => String(s ?? '').replace(/\s+/g, '').toLowerCase();

/** 低于这个值的 importance 一律视为被衰减 bug 打坏的残骸（合法的旧值最小是 0.2） */
const MIN_SANE_IMPORTANCE = 0.05;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 从正文里尽量还原"事情发生的日期"。旧库 source_start/end 全空，只能靠正文。 */
function extractEventTime(content, createdAtUtc) {
  const base = new Date(createdAtUtc);
  const y = base.getUTCFullYear() + 0; // UTC+8 下大致同年，跨年误差标 approx
  let m;
  if ((m = content.match(/(20\d{2})年(\d{1,2})月(\d{1,2})日/))) {
    return { iso: `${m[1]}-${pad(m[2])}-${pad(m[3])}T12:00:00+08:00`, precision: 'day' };
  }
  if ((m = content.match(/(20\d{2})-(\d{2})-(\d{2})/))) {
    return { iso: `${m[1]}-${m[2]}-${m[3]}T12:00:00+08:00`, precision: 'day' };
  }
  if ((m = content.match(/(\d{1,2})月(\d{1,2})日/))) {
    return { iso: `${y}-${pad(m[1])}-${pad(m[2])}T12:00:00+08:00`, precision: 'approx' };
  }
  if ((m = content.match(/(?:^|[^\d])(\d{1,2})\/(\d{1,2})(?![\d/])/))) {
    return { iso: `${y}-${pad(m[1])}-${pad(m[2])}T12:00:00+08:00`, precision: 'approx' };
  }
  return { iso: null, precision: 'unknown' };
}
const pad = (n) => String(n).padStart(2, '0');

const SUBJECT_MAP = { user: 'user', assistant: 'self', self: 'self', shared: 'shared' };
const REFLECTION_SOURCES = new Set(['dream-review', 'identity-update']);
const JUNK = /ROUTE_TEST|检查记忆库连接是否正常|^测试[:：]/i;

// ---------------------------------------------------------------- 变换
const stats = {
  total: raw.length,
  byKind: {},
  byState: {},
  bySource: {},
  importanceRecovered: 0,
  importanceStillDefault: 0,
  importanceReset: 0,
  emotionFromMetadata: 0,
  emotionMissing: 0,
  eventTimeRecovered: 0,
  eventTimeUnknown: 0,
  decayBrokenReset: 0,
  junkPruned: 0,
  dupesMerged: 0,
  subjectFilled: 0,
  warnings: [],
};

const rows = [];
const seen = new Map(); // normalized content -> keeper new id

for (const r of raw) {
  const md = r.metadata ?? {};
  const content = String(r.content ?? '');
  const source = md.source ?? null;
  const isReflection = REFLECTION_SOURCES.has(source);
  const kind = isReflection ? 'reflection' : 'semantic';

  // 主权与归属
  const subject = SUBJECT_MAP[md.subject] ?? 'shared';
  if (!md.subject) stats.subjectFilled++;

  // 重要度：列被默认值 0.5 污染，真值在 metadata 里
  // 另有一批记录被衰减 bug 打成了次正规浮点（如 1.07e-201），
  // 这种值连 real 类型都装不下（会直接报 out of range），必须重置。
  const mdImp = typeof md.importance === 'number' && Number.isFinite(md.importance) ? md.importance : null;
  const colImp = typeof r.importance === 'number' && Number.isFinite(r.importance) ? r.importance : null;
  let importance;
  let importanceResetFrom = null;
  if (mdImp !== null) {
    importance = clamp(mdImp, 0, 1);
    if (colImp === 0.5) stats.importanceRecovered++;
  } else if (colImp !== null && colImp >= MIN_SANE_IMPORTANCE) {
    importance = clamp(colImp, 0, 1);
  } else {
    // metadata 没有真值，列值又是默认 0.5 或衰减残骸 -> 回到中性，交给相似度去决定
    importance = 0.5;
    importanceResetFrom = colImp;
    stats.importanceReset++;
    if (colImp === 0.5) stats.importanceStillDefault++;
  }
  if (colImp !== null && colImp < MIN_SANE_IMPORTANCE) stats.decayBrokenReset++;

  // 情绪坐标：列里全是 0（不是 NULL），真值在 metadata
  const vRaw = typeof md.valence === 'number' && Number.isFinite(md.valence) ? md.valence : null;
  const aRaw = typeof md.arousal === 'number' && Number.isFinite(md.arousal) ? md.arousal : null;
  const v = vRaw === null ? null : clamp(vRaw, -1, 1);
  const a = aRaw === null ? null : clamp(aRaw, 0, 1);
  if (v !== null || a !== null) stats.emotionFromMetadata++;
  else stats.emotionMissing++;

  // 事件时间
  const et = extractEventTime(content, r.created_at);
  if (et.iso) stats.eventTimeRecovered++;
  else stats.eventTimeUnknown++;

  // 状态映射
  let state = 'active';
  if (r.memory_state === 'compressed') state = 'archived';
  else if (r.memory_state === 'pruned') state = 'pruned';
  if (JUNK.test(content)) {
    state = 'pruned';
    stats.junkPruned++;
  }

  const id = randomUUID();
  rows.push({
    id,
    legacyId: r.id,
    kind,
    subject,
    content,
    valence: v,
    arousal: a,
    eventTime: et.iso,
    eventPrecision: et.precision,
    ingestedAt: r.created_at,
    importance,
    state,
    recallCount: typeof r.access_count === 'number' ? r.access_count : 0,
    lastRecalledAt: r.last_accessed ?? null,
    keywords: Array.isArray(md.keywords) ? md.keywords : [],
    provenance: {
      legacy_source: source,
      legacy_memory_type: r.memory_type ?? null,
      legacy_speaker: md.speaker ?? null,
      legacy_subject: md.subject ?? null,
      legacy_importance_column: colImp,
      legacy_importance_metadata: mdImp,
      legacy_memory_state: r.memory_state ?? null,
      importance_reset_from: importanceResetFrom,
      decay_was_broken: colImp !== null && colImp < MIN_SANE_IMPORTANCE,
      migrated_at: new Date().toISOString(),
    },
  });
}

// 去重：归一化后完全相同 -> 保留首条，其余标记 merged_into
for (const row of rows) {
  const key = norm(row.content);
  if (!key) continue;
  const keeper = seen.get(key);
  if (keeper && keeper.id !== row.id) {
    row.state = 'merged_into';
    row.mergedInto = keeper.id;
    stats.dupesMerged++;
  } else if (!keeper) {
    seen.set(key, row);
  }
}

// 统计
for (const r of rows) {
  stats.byKind[r.kind] = (stats.byKind[r.kind] ?? 0) + 1;
  stats.byState[r.state] = (stats.byState[r.state] ?? 0) + 1;
  const s = r.provenance.legacy_source ?? '(无)';
  stats.bySource[s] = (stats.bySource[s] ?? 0) + 1;
}

// 最后一道闸：宁可报错也不要让脏值进库（上一轮就是 1e-201 让整批回滚的）
for (const r of rows) {
  if (!Number.isFinite(r.importance) || r.importance < 0 || r.importance > 1) {
    throw new Error(`importance 越界（legacy_id=${r.legacyId}）: ${r.importance}`);
  }
  if (r.valence !== null && (r.valence < -1 || r.valence > 1)) {
    throw new Error(`valence 越界（legacy_id=${r.legacyId}）: ${r.valence}`);
  }
  if (r.arousal !== null && (r.arousal < 0 || r.arousal > 1)) {
    throw new Error(`arousal 越界（legacy_id=${r.legacyId}）: ${r.arousal}`);
  }
}

// ---------------------------------------------------------------- SQL
const cols = [
  'id', 'kind', 'origin', 'subject', 'content', 'quotes', 'causal',
  'emotion_valence', 'emotion_arousal', 'event_time', 'event_time_precision',
  'ingested_at', 'privacy', 'state', 'importance', 'decay_score',
  'recall_count', 'last_recalled_at', 'keywords', 'merged_into',
  'legacy_id', 'migrated_legacy', 'provenance',
].join(', ');

const lines = [];
lines.push('-- 由 server/scripts/migrate-legacy.js 生成，请勿手工编辑');
lines.push(`-- 数据源: ${jsonPath}`);
lines.push(`-- 生成时间: ${new Date().toISOString()}  行数: ${rows.length}`);
lines.push('begin;');
for (const r of rows) {
  const values = [
    q(r.id),
    q(r.kind),
    q('auto'),
    q(r.subject),
    q(r.content),
    `'[]'::jsonb`,
    'null',
    num(r.valence) ?? 'null',
    num(r.arousal) ?? 'null',
    r.eventTime ? q(r.eventTime) : 'null',
    q(r.eventPrecision),
    q(r.ingestedAt),
    q('private'),
    q(r.state),
    num(r.importance) ?? '0.5',
    '1.0',
    String(r.recallCount),
    r.lastRecalledAt ? q(r.lastRecalledAt) : 'null',
    arr(r.keywords),
    r.mergedInto ? q(r.mergedInto) : 'null',
    q(r.legacyId),
    'true',
    jsonb(r.provenance),
  ].join(', ');
  lines.push(`insert into memory_items (${cols}) values (${values}) on conflict (legacy_id) where legacy_id is not null do nothing;`);
}
lines.push('commit;');
writeFileSync(outPath, lines.join('\n'), 'utf8');

// ---------------------------------------------------------------- 报告
const pct = (n) => `${((n / rows.length) * 100).toFixed(0)}%`;
console.log('================ 迁移对账报告（dry-run，未写库）================');
console.log(`旧库条数            : ${stats.total}`);
console.log(`kind 分布           : ${JSON.stringify(stats.byKind)}`);
console.log(`state 分布          : ${JSON.stringify(stats.byState)}`);
console.log(`来源分布            : ${JSON.stringify(stats.bySource)}`);
console.log('');
console.log(`重要度从 metadata 救回 : ${stats.importanceRecovered}  (${pct(stats.importanceRecovered)})`);
console.log(`重要度仍是默认 0.5     : ${stats.importanceStillDefault}`);
console.log(`重要度重置为中性 0.5   : ${stats.importanceReset}  (原值在 provenance.importance_reset_from)`);
console.log(`被衰减打穿(重置 decay) : ${stats.decayBrokenReset}`);
console.log(`情绪坐标从 metadata 取 : ${stats.emotionFromMetadata}  (${pct(stats.emotionFromMetadata)})`);
console.log(`情绪坐标缺失           : ${stats.emotionMissing}`);
console.log(`事件时间可还原         : ${stats.eventTimeRecovered}  (${pct(stats.eventTimeRecovered)})`);
console.log(`事件时间未知(留 NULL)  : ${stats.eventTimeUnknown}`);
console.log(`重复内容被合并         : ${stats.dupesMerged}`);
console.log(`判定为垃圾并 pruned    : ${stats.junkPruned}`);
console.log(`subject 缺失补 shared  : ${stats.subjectFilled}`);
console.log('');
console.log(`SQL 已写入: ${outPath}  (${(lines.join('\n').length / 1024).toFixed(0)} KB)`);
console.log(APPLY ? '=== 开始执行 ===' : '=== dry-run 结束；加 --apply 才写库 ===');

if (APPLY) {
  const out = execFileSync(
    'bash',
    ['-lc', `cd /opt/opencns && docker compose exec -T postgres psql -U opencns -d opencns -v ON_ERROR_STOP=1 -f - < ${outPath}`],
    { encoding: 'utf8' },
  );
  console.log(out.trim().split('\n').slice(-8).join('\n'));
  const check = execFileSync(
    'bash',
    ['-lc', `cd /opt/opencns && docker compose exec -T postgres psql -U opencns -d opencns -tA -c "select state, count(*) from memory_items group by 1 order by 2 desc;"`],
    { encoding: 'utf8' },
  );
  console.log('--- 写库后 memory_items 状态分布 ---');
  console.log(check.trim());
}
