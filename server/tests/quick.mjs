/**
 * 本地快速测试：JSON 截断修复 + 对话切段。
 * 不连数据库、不调模型 —— 纯函数，秒级反馈。
 *
 * 运行（在 OpenCNS/server 下）：
 *   node --experimental-strip-types tests/quick.mjs   ← 不行，那是 TS
 * 实际用法见仓库说明：先 npm run build，再 node tests/quick.mjs
 */

const { extractJson, repairTruncatedJson } = await import('../build/llm/json.js');
const { detectFabrication } = await import('../build/chat/fabrication.js');
const { segmentMessages } = await import('../build/memory/compress/segment.js');

let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
    pass++;
  } catch (err) {
    console.log(`FAIL  ${name}\n      ${err.message}`);
    fail++;
  }
}

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label ?? ''} 期望 ${e}，实际 ${a}`);
}

console.log('=== JSON 提取与截断修复 ===');

check('完整 JSON 直接解析', () => {
  eq(extractJson('{"scene":"x","importance":0.5}'), { scene: 'x', importance: 0.5 });
});

check('Markdown 围栏容错', () => {
  eq(extractJson('```json\n{"a":1}\n```'), { a: 1 });
});

check('前后有废话也能抠出来', () => {
  eq(extractJson('好的，这是结果：{"a":1} 希望有帮助'), { a: 1 });
});

check('截断在字符串中间 -> 修复', () => {
  const truncated = '{"scene":"她突然说了一句很长的话，然后我笑了，可是后面被砍';
  const repaired = repairTruncatedJson(truncated);
  if (!repaired) throw new Error('未能修复');
  const parsed = JSON.parse(repaired);
  if (typeof parsed.scene !== 'string') throw new Error('scene 不是字符串');
});

check('截断在数组元素后 -> 修复', () => {
  const truncated = '{"scene":"abc","quotes":[{"who":"她","said":"你好"},{"who":"我","sa';
  const out = extractJson(truncated);
  if (out.scene !== 'abc') throw new Error(`scene 不对：${out.scene}`);
});

check('截断在嵌套对象中间 -> 修复', () => {
  const truncated =
    '{"scene":"abc","causal":{"happened":"a","reaction":"b","act":"c","outcome":"d"},"emotion":{"valence":0.5,"arou';
  const out = extractJson(truncated);
  eq(out.causal.outcome, 'd');
  if (out.scene !== 'abc') throw new Error('scene 丢了');
});

check('彻底不是 JSON -> 抛错（不能假装成功）', () => {
  let threw = false;
  try {
    extractJson('这不是 JSON，只是一段话。');
  } catch {
    threw = true;
  }
  if (!threw) throw new Error('应当抛错');
});

console.log('');
console.log('=== 对话切段 ===');

const min = 60 * 1000;
const t = (offsetMin) => new Date(Date.UTC(2026, 7, 11, 14, 0, 0) + offsetMin * min).toISOString();
const msg = (role, content, offsetMin) => ({ role, content, eventTime: t(offsetMin) });

check('长时间间隔 -> 切成两段', () => {
  const segs = segmentMessages([
    msg('user', '第一件事', 0),
    msg('assistant', '回应第一件事', 1),
    msg('user', '半小时后的另一件事', 30),
    msg('assistant', '回应第二件事', 31),
  ]);
  eq(segs.length, 2, '段数');
});

check('连续对话 -> 只有一段', () => {
  const segs = segmentMessages([
    msg('user', 'a', 0),
    msg('assistant', 'b', 1),
    msg('user', 'c', 2),
  ]);
  eq(segs.length, 1, '段数');
});

check('超过条数上限 -> 强制断开', () => {
  const many = [];
  for (let i = 0; i < 45; i++) many.push(msg(i % 2 ? 'assistant' : 'user', `第${i}条`, i));
  const segs = segmentMessages(many, { maxMessages: 20, minMessages: 2 });
  if (segs.length < 3) throw new Error(`期望至少 3 段，实际 ${segs.length}`);
  if (segs.some((s) => s.length > 20)) throw new Error('有段超过上限');
});

check('碎段并入相邻段', () => {
  const segs = segmentMessages([
    msg('user', '完整的四句', 0),
    msg('assistant', '完整回应', 1),
    msg('user', '单独一句就被打断', 30),
  ]);
  eq(segs.length, 1, '碎段应被并入');
});

check('system 消息被剔除且空内容不算一段', () => {
  const segs = segmentMessages([
    { role: 'system', content: '系统提示', eventTime: t(0) },
    msg('user', '   ', 1),
    msg('user', '真正的内容', 2),
    msg('assistant', '回应', 3),
  ]);
  eq(segs.length, 1);
  eq(segs[0].length, 2);
});

console.log('');
console.log('=== 记忆编造检测 ===');

const ctx = '她上次复查：甲状腺大小正常，双侧叶多个小囊性结节约3毫米，C-TIRADS 2类。医生说半年或一年复查一次。';

check('上下文里有 3毫米 -> 不算编造', () => {
  const r = detectFabrication('你上次报告里那个结节大概3毫米，医生说没事。', ctx);
  if (r.suspicious.length !== 0) throw new Error('误报了：' + r.suspicious.join(','));
});

check('编造时间 10:18 -> 抓到', () => {
  const r = detectFabrication('你那天彩超 10:18 开始做的。', ctx);
  if (!r.suspicious.includes('10:18')) throw new Error('没抓到，实际：' + JSON.stringify(r));
});

check('编造日期 10月4号 -> 抓到', () => {
  const r = detectFabrication('10月4号上午去复查的。', ctx);
  if (!r.suspicious.includes('10月4号')) throw new Error('没抓到，实际：' + JSON.stringify(r));
});

check('编造单号 US2026100404 -> 抓到', () => {
  const r = detectFabrication('报告单号是 US2026100404。', ctx);
  if (!r.suspicious.some((s) => s.includes('US'))) throw new Error('没抓到，实际：' + JSON.stringify(r));
});

check('上下文里真有 10:18 时不算编造', () => {
  const r = detectFabrication('你那天彩超 10:18 开始做的。', ctx + ' 彩超 10:18 到 10:24。');
  if (r.suspicious.length !== 0) throw new Error('误报了：' + r.suspicious.join(','));
});

check('普通回复不误报', () => {
  const r = detectFabrication('嗯，医生说没事就好。半年后再查一次，别去揉脖子。', ctx);
  if (r.suspicious.length !== 0) throw new Error('误报了：' + r.suspicious.join(','));
});

check('日期写法不同不算编造（记忆 10/13，他说 10月13号）', () => {
  const c2 = '10/13林遇去医院查甲状腺，约的10:00-10:30。';
  const r = detectFabrication('我记得你10月13号要去查甲状腺。', c2);
  if (r.suspicious.length !== 0) throw new Error('误报了：' + r.suspicious.join(','));
});

check('日期真的不同仍然抓到（记忆 10/13，他说 10月14号）', () => {
  const c2 = '10/13林遇去医院查甲状腺。';
  const r = detectFabrication('你10月14号去查的甲状腺。', c2);
  if (r.suspicious.length === 0) throw new Error('漏检了');
});

check('医学分级码编造能抓到（BI-RADS vs C-TIRADS）', () => {
  const c3 = '甲状腺 C-TIRADS 2类（良性）。';
  const r = detectFabrication('报告是乳腺 BI-RADS 3类。', c3);
  if (r.suspicious.length === 0) throw new Error('漏检了');
});

console.log('');
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
