import { many } from '../../db/pool.js';
import { log } from '../../logger.js';

/**
 * BM25 稀疏检索 —— 补上"关键词"这一路的短板。
 *
 * 为什么要它：现在的关键词路是 SQL ILIKE 硬匹配，换个说法就认不出；
 * 向量路又容易把"感觉像"但没说到点上的记忆排上来。
 * BM25 介于两者之间：按词频和稀有度打分，说法变了也还能对上。
 *
 * 参照 Ombre-Brain（`bm25_index.py`，jieba 分词 + BM25）。
 * 我们没装 jieba，中文用 **bigram**（相邻两字成词）代替：
 * 中文查询短、词边界模糊，bigram 在这个规模上够用，也不用加依赖。
 *
 * 规模：几百条记忆，每次查询现场建索引。真的到几万条再上物化索引。
 */

const K1 = 1.5;
const B = 0.75;

/** 中文按 bigram，字母数字按整词 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const norm = text.toLowerCase();

  // 拉丁词 / 数字
  for (const m of norm.matchAll(/[a-z0-9]{2,}/g)) out.push(m[0]);

  // 中文连续段 → bigram；单字段用 unigram
  for (const m of norm.matchAll(/[\u4e00-\u9fa5]+/g)) {
    const s = m[0];
    if (s.length === 1) {
      out.push(s);
      continue;
    }
    for (let i = 0; i + 1 < s.length; i++) out.push(s.slice(i, i + 2));
  }
  return out;
}

/** 高频虚词 bigram，去掉以免"我们""这个"把分数拉平 */
const STOP = new Set([
  '我们', '你们', '他们', '什么', '这个', '那个', '就是', '不是', '可以', '然后',
  '现在', '今天', '昨天', '明天', '时候', '因为', '所以', '但是', '如果', '还是',
  '一个', '一下', '一直', '已经', '知道', '觉得', '感觉', '真的', '可能', '应该',
  '自己', '没有', '这样', '那样', '这些', '那些', '怎么', '为什',
]);

function terms(text: string): string[] {
  return tokenize(text).filter((t) => !STOP.has(t));
}

export interface Bm25Hit {
  id: string;
  /** 归一化到 0~1 */
  score: number;
  raw: number;
}

interface Doc {
  id: string;
  tf: Map<string, number>;
  len: number;
}

/**
 * 在活跃记忆里做一次 BM25 检索。
 * 返回按分数降序的前 limit 条，score 已归一化（最高的一条 = 1）。
 */
export async function bm25Search(query: string, limit = 12): Promise<Bm25Hit[]> {
  const q = terms(query);
  if (q.length === 0) return [];

  const rows = await many<{ id: string; content: string }>(
    `select id::text, content from memory_items
      where state in ('active', 'archived') and not pinned
      limit 5000`,
  ).catch(() => []);
  if (rows.length === 0) return [];

  const docs: Doc[] = [];
  const df = new Map<string, number>();
  let totalLen = 0;

  for (const r of rows) {
    const toks = terms(r.content);
    if (toks.length === 0) continue;
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    docs.push({ id: r.id, tf, len: toks.length });
    totalLen += toks.length;
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  }

  const N = docs.length;
  if (N === 0) return [];
  const avgdl = totalLen / N;

  const scored: { id: string; raw: number }[] = [];
  for (const d of docs) {
    let s = 0;
    for (const t of q) {
      const f = d.tf.get(t);
      if (!f) continue;
      const n = df.get(t) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      s += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.len) / avgdl)));
    }
    if (s > 0) scored.push({ id: d.id, raw: s });
  }

  scored.sort((a, b) => b.raw - a.raw);
  const top = scored.slice(0, limit);
  const max = top[0]?.raw ?? 0;
  if (max <= 0) return [];

  log.debug('BM25 命中', { docs: N, hits: top.length, top: Number(max.toFixed(2)) });
  return top.map((x) => ({ id: x.id, score: x.raw / max, raw: x.raw }));
}
