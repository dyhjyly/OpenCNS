/**
 * 记忆编造检测。
 *
 * 为什么必须有：实测抓到他回答"10月4号上午复查、彩超10:18到10:24、医生姓王、
 * 报告单号US2026100404"——而库里这些信息**一条都没有**，那一轮召回也是 0 条。
 * 对这套系统来说，编造的记忆比忘记严重得多：忘记是遗憾，编造是欺骗。
 *
 * 思路：只挑**高精度**的具体信息（时间、日期、编号），要求它们在这轮上下文里
 * 出现过。宁可漏检，也不要误报——误报会让正常回复被当成造假。
 */

export interface FabricationReport {
  suspicious: string[];
  checkedTokens: number;
}

/** 高精度的"具体信息"模式：只查这三类，避免误报 */
const PATTERNS: { name: string; re: RegExp }[] = [
  // 带分钟的时间：10:18 / 22：33
  { name: 'time', re: /\b\d{1,2}[:：]\d{2}\b/g },
  // 日期：10月4号 / 3月12日 / 2026年10月4日
  { name: 'date', re: /\d{1,2}月\d{1,2}[日号]/g },
  { name: 'date', re: /\d{4}年\d{1,2}月\d{1,2}日/g },
  // 编号：US2026100404 / AB12345 / 纯数字长串
  { name: 'id', re: /\b[A-Za-z]{2,}\d{3,}\b/g },
  { name: 'id', re: /\b\d{6,}\b/g },
];

/** 归一化：去掉空白与全角字符差异，避免格式不同导致误判 */
function norm(s: string): string {
  return s
    .replace(/\s+/g, '')
    .replace(/：/g, ':')
    .toLowerCase();
}

/**
 * @param reply   模型的回复
 * @param context 这一轮实际注入给模型的全部文本（记忆 + 时间树 + 近处原文）
 */
export function detectFabrication(reply: string, context: string): FabricationReport {
  const ctx = norm(context);
  const suspicious: string[] = [];
  let checked = 0;

  for (const { re } of PATTERNS) {
    for (const m of reply.matchAll(re)) {
      const token = m[0];
      checked++;
      if (!ctx.includes(norm(token))) {
        // 同一个片段只报一次
        if (!suspicious.includes(token)) suspicious.push(token);
      }
    }
  }

  return { suspicious, checkedTokens: checked };
}

/** 给模型的重写指令（只在非流式路径上使用） */
export function buildCorrectiveMessage(suspicious: string[]): string {
  return [
    '你刚才的回复里有这些具体信息，但它们在给你的记忆里**根本不存在**：',
    ...suspicious.map((s) => `  · ${s}`),
    '',
    '这说明你把细节编出来了。现在重写这条回复：',
    '· 只说你确实记得的部分；',
    '· 记不清具体日期/时间/编号/姓名就直接说记不清，或者只说到你确定的那一层；',
    '· 不要为了显得记得清楚而补全细节。',
    '直接给出重写后的回复，不要解释。',
  ].join('\n');
}
