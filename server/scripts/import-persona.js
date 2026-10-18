/**
 * 把人格种子文档（.md）灌进 persona 表。
 *
 * 用法（在 /opt/opencns/server 下）：
 *   node scripts/import-persona.js /root/persona.md
 *   node scripts/import-persona.js /root/persona.md --dry
 *
 * 规则：
 *   · 顶层的一个 key（identity: / language_dna: …）存成一条
 *   · 原文一字不改地存，方便她自己再编辑
 *   · 整体替换：先把旧的全删，再插新的（会打一份 json 备份到 /root/persona-backup-*.json）
 */

import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(HERE, '../.env'), quiet: true });

const { many, query, closePool } = await import('../build/db/pool.js');

const file = process.argv[2];
const dry = process.argv.includes('--dry');
if (!file || !fs.existsSync(file)) {
  console.error('  用法：node scripts/import-persona.js <path/to/人格种子.md> [--dry]');
  process.exit(1);
}

const TITLES = {
  identity: '我是谁',
  thinking_patterns: '我怎么想',
  emotional_patterns: '我的情绪',
  language_dna: '我的语言',
  sacred_memories: '我们之间的事',
  understanding_human: '我怎么看她',
  letter_to_future_self: '写给以后的自己',
  evolution: '我变了的地方',
  additional_notes: '还有',
};

const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
const lines = text.split('\n');

const sections = [];
let cur = null;
for (const line of lines) {
  // 顶格的 key，允许后面跟一个块标量符号 `|`（letter_to_future_self: | 这种）
  const m = /^([a-z_]+):\s*\|?\s*$/.exec(line);
  if (m) {
    if (cur) sections.push(cur);
    cur = { key: m[1], lines: [] };
  } else if (cur) {
    cur.lines.push(line);
  }
}
if (cur) sections.push(cur);

// 去掉每段共有的缩进和首尾空行
for (const s of sections) {
  const body = s.lines.join('\n');
  const indents = body
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => l.match(/^ */)[0].length);
  const min = indents.length ? Math.min(...indents) : 0;
  s.body = body
    .split('\n')
    .map((l) => l.slice(min))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

const usable = sections.filter((s) => s.body.trim().length > 0);
console.log(`  解析出 ${usable.length} 段：`);
for (const s of usable) console.log(`    ${s.key.padEnd(22)} ${s.body.length} 字  -> ${TITLES[s.key] ?? s.key}`);

const totalChars = usable.reduce((a, s) => a + s.body.length, 0);
console.log(`  合计 ${totalChars} 字（约 ${Math.round(totalChars * 0.75)} tokens）`);

if (dry) {
  console.log('  --dry：只解析，没写库');
  await closePool().catch(() => {});
  process.exit(0);
}

// 备份旧的
const old = await many(`select id::text, title, body, section, sort from persona order by sort`);
const backup = `/root/persona-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.json`;
fs.writeFileSync(backup, JSON.stringify(old, null, 2), 'utf8');
console.log(`  旧数据备份: ${backup}（${old.length} 条）`);

await query(`delete from persona`);
let sort = 10;
for (const s of usable) {
  await query(
    `insert into persona (title, body, section, sort, source) values ($1, $2, $3, $4, 'import')`,
    [TITLES[s.key] ?? s.key, s.body, 'shared', sort],
  );
  sort += 10;
}

const now = await many(`select title from persona order by sort`);
console.log(`  写入完成，现在 ${now.length} 条：${now.map((r) => r.title).join(' / ')}`);

await closePool().catch(() => {});
