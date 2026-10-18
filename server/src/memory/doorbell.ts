import type { RecallCandidate } from './recall/index.js';

/**
 * 门铃。
 *
 * 林遇的原话：不要每轮都把记忆内容塞进去，"只需要一个门铃提醒就好了"——
 * 告诉他"这件事我在意过，关键词是什么"，然后**他自己决定**去翻原文，
 * 还是直接问她。
 *
 * 所以这里只输出：日期、编号、以及**同时出现在她这句话和记忆里**的词。
 * 不给内容 —— 给了内容，那些第三人称的老摘要就会混进他的语气里。
 */

const STOP = new Set([
  '我们', '你们', '他们', '什么', '这个', '那个', '就是', '不是', '可以', '然后',
  '现在', '今天', '昨天', '明天', '时候', '因为', '所以', '但是', '如果', '还是',
  '一个', '一下', '一直', '已经', '知道', '觉得', '感觉', '真的', '可能', '应该',
]);

function norm(s: string): string {
  return s
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .toLowerCase();
}

/** 取中文/英文的二元组（中文没空格，二元组是唯一便宜的切分办法） */
function bigrams(s: string): Set<string> {
  const t = norm(s);
  const out = new Set<string>();
  for (let i = 0; i + 1 < t.length; i++) {
    const g = t.slice(i, i + 2);
    if (STOP.has(g)) continue;
    if (!/[\u4e00-\u9fa5a-z0-9]{2}/.test(g)) continue;
    out.add(g);
  }
  return out;
}

/** 她这句话和这些记忆共同出现的词 —— 也就是"为什么会召回" */
export function sharedKeywords(userText: string, memories: { content: string }[], limit = 4): string[] {
  const mine = bigrams(userText);
  const score = new Map<string, number>();
  for (const m of memories) {
    for (const g of bigrams(m.content)) {
      if (mine.has(g)) score.set(g, (score.get(g) ?? 0) + 1);
    }
  }
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([g]) => g);
}

const KIND_CN: Record<string, string> = {
  episode: '一段对话',
  semantic: '一件事',
  experience: '你的经历',
  reflection: '你的想法',
  pinned: '底座',
};

export interface Doorbell {
  /** 给模型的几行（空字符串表示没响） */
  block: string;
  /** 方便日志与工具路由 */
  ids: string[];
  keywords: string[];
}

export function buildDoorbell(recalled: RecallCandidate[], userText: string): Doorbell {
  if (recalled.length === 0) return { block: '', ids: [], keywords: [] };

  const keywords = sharedKeywords(userText, recalled);
  const top = recalled.slice(0, 3);
  const lines = top.map((r) => {
    const when = r.event_time ? String(r.event_time).slice(0, 10) : '没有日期';
    return `· ${when}｜${KIND_CN[r.kind] ?? r.kind}｜编号 ${r.id.slice(0, 8)}`;
  });

  const block = [
    '【门铃】她这句话和你以前在意过的几件事有关。这里只给编号，不给内容。',
    keywords.length ? `共同的关键词：${keywords.join(' / ')}` : '',
    ...lines,
    recalled.length > top.length ? `（还有 ${recalled.length - top.length} 件更远的，没列出来）` : '',
    '想看原文就用 recall_memory 工具（可以只传编号）；不想翻就直接问她。别猜内容。',
  ]
    .filter(Boolean)
    .join('\n');

  return { block, ids: recalled.map((r) => r.id), keywords };
}
