import { many, query } from '../../db/pool.js';
import { getEmbeddingProvider } from '../../embedding/index.js';
import { chatJson } from '../../llm/client.js';
import { log, errFields } from '../../logger.js';
import { getSetting } from '../../settings/index.js';
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

// 裁决要读候选，候选越多它越慢（实测 24 条时裁决单独就要 4~6 秒）。
// 候选本来就按分数排好序，取前 12 条足够判断，也让它更专注。
const MAX_CANDIDATES = 8;
const MAX_RECALLED = 3;
  // 她说最多 3 条就够了，多了反而稀释

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

/**
 * 从"回忆类问句"里剥出真正有信息量的词。
 *
 * 剥掉回忆意图词与虚词（它们几乎出现在每条记忆的检索里，只会带来噪声），
 * 剩下的话再切成 2-gram —— 因为记忆里的写法未必连续：
 *   她说「彩超报告」，记忆里是「做彩超，报告：…」，整词匹配会漏。
 * 切成「彩超」「超报」「报告」就能命中。
 */
function contentWords(text: string): string[] {
  const stripped = text.replace(
    /(还?记得吗|还?记得|记不记得|想不起来|想起|回想|回忆|之前|以前|过去|当时|那次|上次|我们说过|我们聊过|我们决定|告诉我|说一下|是什么|什么|怎么样|那个|这个|是不是|有没有|具体|情况|事情|吗|呢|吧|啊|的|了|是|我|你|他|她|它|说)/g,
    ' ',
  );

  const out = new Set<string>();
  for (const run of stripped.split(/[^\u4e00-\u9fa5]+/)) {
    if (run.length < 2) continue;
    // 整词（≥3 字的保留，作为更强的匹配）
    if (run.length >= 3) out.add(run);
    // 2-gram
    for (let i = 0; i + 2 <= run.length; i++) out.add(run.slice(i, i + 2));
  }
  return [...out].slice(0, 10);
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
  cooldown_until: string | null;}

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

/** F 正文词命中：她用的词真的出现在某条记忆里，就该被捞出来（只在明确回忆时跑）。
 *
 * 为什么需要它：日记式的长记忆（三五百字讲一整天的所有事）和一句短问句的
 * 向量相似度天然偏低，而"复查""医院"这些词明明就在那条记忆里。
 * 实测踩过：问"上次复查结果"，向量路与近因路都没捞到，于是召回了 0 条。
 */
async function routeContentMatch(words: string[], limit: number): Promise<Row[]> {
  if (words.length === 0) return [];
  const patterns = words.map((w) => `%${w}%`);
  return many<Row>(
    `select ${SELECT_COLS}, 0.5::real as similarity
       from memory_items
      where state in ('active','archived')
        and content like any($1::text[])
      order by importance desc, coalesce(event_time, ingested_at) desc
      limit $2`,
    [patterns, limit],
  );
}

/** C 情绪相似（需过门控）。mood 用最近几条情景记忆的情绪均值当"此刻的心情"代理。 */
async function routeEmotion(limit: number): Promise<Row[]> {  const mood = await many<{ v: number; a: number }>(
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
  const byRoute: Record<string, number> = {
    semantic: 0,
    keyword: 0,
    emotion: 0,
    association: 0,
    recency: 0,
    content: 0,
  };
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
    // 明确回忆时放宽到 24 条：她说"上次…"就是在找一条很具体的记忆，
    // 候选太少会让它错过排在 15~24 名的那条。
    semanticRows = await routeSemantic(embedding, explicit ? 24 : 16);
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

  // F 正文词命中（明确回忆时）
  let contentRows: Row[] = [];
  if (explicit) {
    try {
      const words = contentWords(userMessage);
      contentRows = await routeContentMatch(words, 10);
      byRoute.content = contentRows.length;
      if (words.length > 0) log.debug('正文词命中候选', { words, hits: contentRows.length });
    } catch (err) {
      log.error('正文词召回失败', errFields(err));
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

  /*
   * E 最近发生（只在明确回忆时跑）
   *
   * 她说"上次…"时，最该想起的往往是**最近那几件相关的事**，而语义相似度
   * 未必把它们排上来（日记式长记忆和一句短问句的向量相似度天然偏低）。
   * 实测踩过：问"上次复查结果"，召回 0 条，模型就把整个病史编了出来。
   * 这一路不参与裁决的取舍权，只是把最近的高重要度记忆**放进候选池**，
   * 让裁决器有机会看到它们。
   */
  let recencyRows: Row[] = [];
  if (explicit) {
    try {
      recencyRows = await many<Row>(
        `select ${SELECT_COLS}, 0.3::real as similarity
           from memory_items
          where state in ('active','archived')
            and importance >= 0.5
            and embedding is not null
          order by coalesce(event_time, ingested_at) desc
          limit 12`,
      );
      byRoute.recency = recencyRows.length;
    } catch (err) {
      log.error('最近记忆召回失败', errFields(err));
    }
  }

  /*
   * G BM25 稀疏检索（3.0 加）
   *
   * 补关键词路的短板：ILIKE 是硬匹配，换个说法就认不出；
   * 向量路又容易把"感觉像"但没说到点上的排上来。
   * BM25 按词频和稀有度打分，介于两者之间。
   */
  let bm25Rows: Row[] = [];
  try {
    const { bm25Search } = await import('./bm25.js');
    const hits = await bm25Search(userMessage, explicit ? 14 : 8);
    if (hits.length > 0) {
      const ids = hits.map((h) => h.id);
      const rows = await many<Row>(
        `select ${SELECT_COLS} from memory_items
          where id = any($1::uuid[]) and state in ('active','archived')`,
        [ids],
      );
      const scoreById = new Map(hits.map((h) => [h.id, h.score]));
      bm25Rows = rows.map((r) => ({ ...r, similarity: scoreById.get(r.id) ?? 0 }));
      byRoute.bm25 = bm25Rows.length;
    }
  } catch (err) {
    log.error('BM25 召回失败', errFields(err));
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
  add(recencyRows, 'recency');
  add(contentRows, 'content');
  add(bm25Rows, 'bm25');

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

  /*
   * 选谁去裁决。
   *
   * 明确回忆时**按路线保额取样**，而不是简单取综合分前 N。
   * 实测踩过：她问"上次复查结果"，content 路明明找到了 10 条含"复查"的记忆，
   * 但综合分排序时被语义路的 24 条挤出前 12，裁决器压根没看到那条真记忆，
   * 于是全拒、召回 0 条。
   */
  const top: RecallCandidate[] = [];
  const picked = new Set<string>();
  const takeRoute = (route: string, quota: number) => {
    for (const c of candidates) {
      if (top.length >= MAX_CANDIDATES || quota <= 0) return;
      if (picked.has(c.id) || !c.routes.includes(route)) continue;
      top.push(c);
      picked.add(c.id);
      quota--;
    }
  };

  if (explicit) {
    takeRoute('content', 6);
    takeRoute('keyword', 4);
    takeRoute('semantic', 6);
    takeRoute('recency', 3);
    takeRoute('association', 2);
    takeRoute('emotion', 2);
    for (const c of candidates) {
      if (top.length >= MAX_CANDIDATES) break;
      if (!picked.has(c.id)) {
        top.push(c);
        picked.add(c.id);
      }
    }
  } else {
    top.push(...candidates.slice(0, MAX_CANDIDATES));
  }

  if (top.length === 0) {
    return { ...empty, byRoute, droppedByCooldown, emotionRouteAllowed: explicit };
  }

  /*
   * 要不要花那笔钱裁决？
   *
   * 林遇的算法（2026-10-29）："召回最多 3 条给他就好"，那就不必再花一次
   * cognitive 调用让模型再挑一遍 —— 裁决是思考模式，光理由就能吐上千字。
   *
   * 开关：settings 里的 recall.judge
   *   never （默认）拿分数前 3 条就走，不调模型
   *   auto          候选 ≤3 条才跳过
   *   always        每次都裁决（质量最好，最贵）
   */
  const judgeMode = String(getSetting('recall.judge', 'never'));
  const MIN_SCORE_NO_JUDGE = 0.3;

  const takeByScore = (rows: RecallCandidate[]) => {
    const strong = rows.filter(
      (c) => (c.similarity ?? 0) >= 0.55 || c.importance >= 0.75 || c.score >= MIN_SCORE_NO_JUDGE,
    );
    return strong.slice(0, MAX_RECALLED);
  };

  if (judgeMode === 'never' || (judgeMode === 'auto' && top.length <= 3)) {
    const picked = takeByScore(top);
    if (picked.length === 0) {
      return {
        ...empty,
        byRoute,
        droppedByCooldown,
        emotionRouteAllowed: explicit,
        judgeReason: '候选都不够强',
      };
    }
    for (const c of picked) {
      await query(`select touch_exposure($1, 1.5)`, [c.id]).catch(() => undefined);
    }
    log.info('按分数直接给，没调裁决', { n: top.length, 取: picked.length, mode: judgeMode });
    return {
      recalled: picked,
      candidates: top.length,
      byRoute,
      droppedByCooldown,
      emotionRouteAllowed: explicit,
      judgeUsed: false,
      judgeReason: `${judgeMode === 'never' ? '压成本：' : ''}按分数取前 ${picked.length} 条`,
    };
  }

  // 裁决：由认知模型判断"哪几条真的帮得上"
  //
  // 候选正文要**截短**：日记式记忆常有三五百字，12 条就是四五千字输入，
  // 裁决光读输入就要花十秒（实测 11.9 秒）。判断相关性看前 180 字足够。
  let selectedIds: string[] = [];
  let judgeReason: string | undefined;
  let judgeUsed = false;
  try {
    const judgeInput: JudgeCandidate[] = top.map((c) => ({
      id: c.id,
      kind: c.kind,
      content: c.content.length > 180 ? `${c.content.slice(0, 180)}…` : c.content,
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

  // 只记曝光（用于冷却，避免同一段反复出现），**不加强化、不动权重**。
  for (const item of recalled) {
    try {
      await query(`select touch_exposure($1, 6)`, [item.id]);
    } catch (err) {
      log.warn('记录曝光失败', { id: item.id, ...errFields(err) });
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
