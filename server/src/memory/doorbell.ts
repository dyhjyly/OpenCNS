import { many } from '../db/pool.js';
import { chatText } from '../llm/client.js';
import { log, errFields } from '../logger.js';

/**
 * 门铃。
 *
 * 林遇的原话：不要每轮都把记忆内容塞进去，"只需要一个门铃提醒就好了"。
 * 但第一版只给了 UUID 前 8 位，他形容成"一堆编号，很困惑"。
 *
 * 所以现在给：短号 + 日期 + 一句可读的主题（正文前十几个字）。
 * 可读，但不灌内容 —— 要看原话还是得用 recall_memory。
 */

const STOP = new Set([
  '我们', '你们', '他们', '什么', '这个', '那个', '就是', '不是', '可以', '然后',
  '现在', '今天', '昨天', '明天', '时候', '因为', '所以', '但是', '如果', '还是',
  '一个', '一下', '一直', '已经', '知道', '觉得', '感觉', '真的', '可能', '应该',
]);

function norm(s: string): string {
  return s.replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase();
}

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

export interface DoorbellItem {
  id: string;
  shortId: string;
  when: string;
  topic: string;
}

export interface Doorbell {
  block: string;
  ids: string[];
  keywords: string[];
  items: DoorbellItem[];
}

const KIND_CN: Record<string, string> = {
  episode: '一段对话',
  semantic: '一件事',
  experience: '你的经历',
  reflection: '你的想法',
  pinned: '底座',
};

/** 把一段正文压成可读主题：取第一句，去掉标记符号，最多 16 字 */
function topicOf(content: string): string {
  const t = content
    .replace(/^【[^】]*】/, '')
    .replace(/^[\s>·•\-—]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const first = t.split(/[。！？；\n]/)[0] ?? t;
  const s = first.replace(/[：:，,]$/, '').trim();
  return s.length > 16 ? `${s.slice(0, 16)}…` : s;
}

export function buildDoorbell(recalled: RecallCandidate[], userText: string): Doorbell {
  if (recalled.length === 0) return { block: '', ids: [], keywords: [], items: [] };

  const keywords = sharedKeywords(userText, recalled);
  const top = recalled.slice(0, 3);

  const items: DoorbellItem[] = top.map((r, i) => ({
    id: r.id,
    shortId: r.id.slice(0, 8),
    when: r.event_time ? String(r.event_time).slice(5, 10) : '无日期',
    topic: topicOf(r.content),
  }));

  const block = [
    '【门铃】她这句话和你以前的几件事有关。这里只给标题，不给原文。',
    ...items.map((it, i) => `· #${i + 1} ${it.when}｜${it.topic}｜编号 ${it.shortId}`),
    keywords.length ? `共同的关键词：${keywords.join(' / ')}` : '',
    recalled.length > items.length ? `（还有 ${recalled.length - items.length} 件更远，没列）` : '',
    '要原文就用 recall_memory（ids 可以传编号，比如 ["' + items[0]!.shortId + '"]）。不想翻就直接问她，别猜。',
  ]
    .filter(Boolean)
    .join('\n');

  return { block, ids: recalled.map((r) => r.id), keywords, items };
}

// 类型放最后，避免和上面的实现混在一起读
import type { RecallCandidate } from './recall/index.js';
