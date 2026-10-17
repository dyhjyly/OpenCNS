import { many, query } from '../../db/pool.js';
import { getEmbeddingProvider } from '../../embedding/index.js';
import { chatJson } from '../../llm/client.js';
import { log, errFields } from '../../logger.js';
import {
  buildJudgeUserMessage,
  RECALL_JUDGE_SYSTEM_PROMPT,
  type JudgeCandidate,
} from './prompt.js';

/**
 * 召回 v2：四路候选 + 两层克制 + 裁决。
 *
 * 四路（对应构想里的四种"想起"）：
 *   A 语义相似 —— 意思像
 *   B 关键词命中 —— 词撞上了（人名、物件、地名靠它）
 *   C 情绪相似 —— 此刻心情接近当时的心情（**要过情绪门控**）
 *   D 联想连带 —— 顺着记忆之间已建好的边带出来
 *
 * 两层克制（对应构想里的"不相关的不递、递过的不重复"）：
 *   ① 情绪门控：情绪路只在她明确想回忆时才放行
 *   ② 防复读冷却：刚想起过的进入冷却，曝光越多冷却越长（cooldown_until）
 *
 * 最后再由认知模型裁决"哪几条真的帮得上"，并且**只给真正用上的加重要度** ——
 * 旧版是检索到就 +0.02，等于噪声也在强化。
 */

export interface RecallCandidate {
  id: string;
  kind: string;
  content: string;
  quotes: unknown;
  emotion_valence: number | null;
  emotion_arousal: number | null;
  importance: number;
  event_time: string | null;
  ingested_at: string;
  similarity: number | null;
  score: number;
  routes: string[];
}

export interface RecallResult {
  recalled: RecallCandidate[];
  candidates: number;
  byRoute: Record<string, number>;
  droppedByCooldown: number;
  emotionRouteAllowed: boolean;
  judgeUsed: boolean;
  judgeReason?: string;
}

const MAX_CANDIDATES = 24;
const MAX_RECALLED = 5;

/** 明确想回忆的语气 —— 情绪路与"多给几条"都靠它放行 */
const EXPLICIT_RECALL = [
  '记得',
  '记不记得',
  '还记得',
  '想起',
  '回想',
  '回忆',
  '之前',
  '以前',
  '过去',
  '当时',
  '那次',
  '我们说过',
  '我们聊过',
  '我们决定',
];

export function isExplicitRecall(text: string): boolean {
  return EXPLICIT_RECALL.some((k) => text.includes(k));
}

/** 纯寒暄（去掉标点、动作、语气词后没有实际语义）——不值得触发召回 */
export function isCasual(text: string): boolean {
  const normalized = text
    .replace(/（[^）]*）|\([^)]*\)/gu, '')
    .replace(/[\s\p{P}\p{S}\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '')
    .trim();
  if (!normalized) return true;
  return /^(嘿|哈|嘻|呵|呜|嗯|哦|啊|呀|哎|诶|唔|好|行|可以|晚安|早安|收到|知道了)+$/u.test(normalized);
}

/** 从一句话里粗提查询词：中文按 2-gram，英文/数字按词 */
function queryTokens(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/[A-Za-z0-9]{2,}/g)) out.add(m[0].toLowerCase());
  const han = text.replace(/[^\u4e00-\u9fa5]/g, '');
  for (let i = 0; i + 2 <= han.length; i++) out.add(han.slice(i, i + 2));
  return [...out].slice(0, 24);
}

interface Row {
  id: string;
  kind: string;
  content: string;
  quotes: unknown;
  emotion_valence: number | null;
  emotion_arousal: number | null;
  importance: number;
  event_time: string | null;
  ingested_at: string;
  similarity: number | null;
  cooldown_until: string | null;
}

const SELECT_COLS = `id, kind, content, quotes, emotion_valence, emotion_arousal,
                     importance, event_time, ingested_at, cooldown_until`;

/** A 语义相似 */
async function routeSemantic(embedding: number[], limit: number): Promise<Row[]> {
  return many<Row>(
    `select ${SELECT_COLS}, (1 - (embedding <=> $1::vector))::real as similarity
       from memory_items
      where embedding is not null and state in ('active','archived')
      order by embedding <=> $1::vector
      limit $2`,
    [`[${embedding.join(',')}]`, limit],
  );
}

/** B 关键词命中（trigram 词相似度 或 关键词数组重叠） */
async function routeKeyword(text: string, tokens: string[], limit: number): Promise<Row[]> {
  if (tokens.length === 0) return [];
  return many<Row>(
    `select ${SELECT_COLS}, word_similarity($1, content)::real as similarity
       from memory_items
      where state in ('active','archived')
        and (word_similarity($1, content) > 0.12 or keywords && $2::text[])
      order by word_similarity($1, content) desc
      limit $3`,
    [text, tokens, limit],
  );
}

/** C 情绪相似（需过门控）。mood 用最近几条情景记忆的情绪均值当"此刻的心情"代理。 */
async function routeEmotion(limit: number): Promise<Row[]> {
  const mood = await many<{ v: number; a: number }>(
    `select avg(emotion_valence)::real as v, avg(emotion_arousal)::real as a
       from (
         select emotion_valence, emotion_arousal
           from memory_items
          where kind = 'episode' and emotion_valence is not null
          order by ingested_at desc limit 3
       ) t`,
  );
  const v = mood[0]?.v;
  const a = mood[0]?.a;
  if (typeof v !== 'number' || typeof a !== 'number') return [];

  return many<Row>(
    `select ${SELECT_COLS},
            (1 - (abs(emotion_valence - $1) / 2 + abs(emotion_arousal - $2)))::real as similarity
       from memory_items
      where state in ('active','archived')
        and emotion_valence is not null and emotion_arousal is not null
      order by similarity desc
      limit $3`,
    [v, a, limit],
  );
}

/** D 联想连带：顺着已建好的边，从种子记忆带出邻居 */
async function routeAssociation(seedIds: string[], limit: number): Promise<Row[]> {
  if (seedIds.length === 0) return [];
  // 注意：memory_edges 与 memory_items 都有 id，SELECT_COLS 里的裸列名会歧义
  //（实测报 column reference "id" is ambiguous，这个路由曾每一轮都失败）。
  // 所以这里显式给 memory_items 的每一列加上 m. 前缀。
  return many<Row>(
    `select m.id, m.kind, m.content, m.quotes, m.emotion_valence, m.emotion_arousal,
            m.importance, m.event_time, m.ingested_at, m.cooldown_until,
            (e.weight * 0.8)::real as similarity
       from memory_edges e
       join memory_items m on m.id = e.to_id
      where e.from_id = any($1::uuid[])
        and m.state in ('active','archived')
      order by e.weight desc
      limit $2`,
    [seedIds, limit],
  );
}

/** 时间新鲜度：30 天内基本满分，之后缓慢衰减 */
function recencyScore(ingestedAt: string): number {
  const days = (Date.now() - new Date(ingestedAt).getTime()) / 86_400_000;
  return 1 / (1 + Math.max(0, days - 30) / 120);
}

export async function recall(userMessage: string, opts: { limit?: number } = {}): Promise<RecallResult> {
  const limit = opts.limit ?? MAX_RECALLED;
  const byRoute: Record<string, number> = { semantic: 0, keyword: 0, emotion: 0, association: 0 };
  const empty: RecallResult = {
    recalled: [],
    candidates: 0,
    byRoute,
    droppedByCooldown: 0,
    emotionRouteAllowed: false,
    judgeUsed: false,
  };

  if (!userMessage.trim() || isCasual(userMessage)) {
    return { ...empty, judgeReason: '消息过短或纯寒暄，不触发召回' };
  }

  const explicit = isExplicitRecall(userMessage);

  // A 语义
  let semanticRows: Row[] = [];
  try {
    const provider = getEmbeddingProvider();
    const [embedding] = await provider.embed([userMessage]);
    if (!embedding) throw new Error('查询向量为空');
    semanticRows = await routeSemantic(embedding, 16);
    byRoute.semantic = semanticRows.length;
  } catch (err) {
    log.error('语义召回失败', errFields(err));
  }

  // B 关键词
  let keywordRows: Row[] = [];
  try {
    keywordRows = await routeKeyword(userMessage, queryTokens(userMessage), 12);
    byRoute.keyword = keywordRows.length;
  } catch (err) {
    log.error('关键词召回失败', errFields(err));
  }

  // C 情绪（过门控：只有她明确想回忆时才放行）
  let emotionRows: Row[] = [];
  if (explicit) {
    try {
      emotionRows = await routeEmotion(10);
      byRoute.emotion = emotionRows.length;
    } catch (err) {
      log.error('情绪召回失败', errFields(err));
    }
  }

  // D 联想（用语义前几条当种子）
  let assocRows: Row[] = [];
  try {
    assocRows = await routeAssociation(
      semanticRows.slice(0, 5).map((r) => r.id),
      8,
    );
    byRoute.association = assocRows.length;
  } catch (err) {
    log.error('联想召回失败', errFields(err));
  }

  // 合并去重
  const merged = new Map<string, { row: Row; routes: string[]; similarity: number }>();
  const add = (rows: Row[], route: string) => {
    for (const row of rows) {
      if (!row.content?.trim()) continue;
      const sim = typeof row.similarity === 'number' && Number.isFinite(row.similarity) ? row.similarity : 0;
      const existing = merged.get(row.id);
      if (existing) {
        existing.routes.push(route);
        existing.similarity = Math.max(existing.similarity, sim);
      } else {
        merged.set(row.id, { row, routes: [route], similarity: sim });
      }
    }
  };
  add(semanticRows, 'semantic');
  add(keywordRows, 'keyword');
  add(emotionRows, 'emotion');
  add(assocRows, 'association');

  // 两层克制：冷却过滤
  //
  // 关键例外：**她在明确问过去的事时，冷却无效**。
  // 冷却是为了"不要反复主动提起同一条"，不是"问起来也装作想不起来"。
  // 实测踩过：她问"你还记得上次复查结果吗"，那几条正在冷却里被丢掉，
  // 系统老老实实回答"这个我没记住"——这是把防复读变成了失忆。
  const now = Date.now();
  let droppedByCooldown = 0;
  const candidates: RecallCandidate[] = [];
  for (const { row, routes, similarity } of merged.values()) {
    const cooling = Boolean(row.cooldown_until && new Date(row.cooldown_until).getTime() > now);
    if (cooling && !explicit) {
      droppedByCooldown++;
      continue;
    }
    const score =
      0.55 * similarity +
      0.25 * (row.importance ?? 0.5) +
      0.12 * recencyScore(row.ingested_at) +
      0.08 * Math.min(1, routes.length / 3) +
      // 冷却中的记忆即便被放行，也排在后面
      (cooling ? -0.05 : 0);
    candidates.push({
      id: row.id,
      kind: row.kind,
      content: row.content,
      quotes: row.quotes,
      emotion_valence: row.emotion_valence,
      emotion_arousal: row.emotion_arousal,
      importance: row.importance,
      event_time: row.event_time,
      ingested_at: row.ingested_at,
      similarity: similarity || null,
      score: Number(score.toFixed(4)),
      routes,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  const top = candidates.slice(0, MAX_CANDIDATES);

  if (top.length === 0) {
    return { ...empty, byRoute, droppedByCooldown, emotionRouteAllowed: explicit };
  }

  // 裁决：由认知模型判断"哪几条真的帮得上"
  let selectedIds: string[] = [];
  let judgeReason: string | undefined;
  let judgeUsed = false;
  try {
    const judgeInput: JudgeCandidate[] = top.map((c) => ({
      id: c.id,
      kind: c.kind,
      content: c.content,
      event_time: c.event_time,
      importance: c.importance,
      similarity: c.similarity,
      routes: c.routes,
    }));
    const verdict = await chatJson<{ selectedIds?: unknown; reason?: string }>(
      [
        { role: 'system', content: RECALL_JUDGE_SYSTEM_PROMPT },
        { role: 'user', content: buildJudgeUserMessage(userMessage, judgeInput) },
      ],
      { endpoint: 'cognitive', temperature: 0.1, maxTokens: 2000, label: 'recall-judge' },
    );
    judgeUsed = true;
    judgeReason = verdict.reason;
    const valid = new Set(top.map((c) => c.id));
    selectedIds = Array.isArray(verdict.selectedIds)
      ? verdict.selectedIds.filter((id): id is string => typeof id === 'string' && valid.has(id)).slice(0, limit)
      : [];
  } catch (err) {
    // 裁决失败就退回按分数取前 N —— 但必须记下来，不能假装裁决过了
    log.error('召回裁决失败，退回按分数取前 N', errFields(err));
    selectedIds = top.slice(0, limit).map((c) => c.id);
  }

  const recalled = selectedIds.map((id) => top.find((c) => c.id === id)!).filter(Boolean);

  // 只给"真的用上"的加重要度，且带冷却（曝光越多冷却越长）
  for (const item of recalled) {
    try {
      await query(`select reinforce_memory($1, true, 6)`, [item.id]);
    } catch (err) {
      log.warn('强化失败', { id: item.id, ...errFields(err) });
    }
  }

  log.info('召回完成', {
    candidates: top.length,
    recalled: recalled.length,
    byRoute,
    droppedByCooldown,
    emotionRouteAllowed: explicit,
    judgeUsed,
    topScores: recalled.map((r) => `${r.routes.join('+')}:${r.score}`),
  });

  return { recalled, candidates: top.length, byRoute, droppedByCooldown, emotionRouteAllowed: explicit, judgeUsed, judgeReason };
}
