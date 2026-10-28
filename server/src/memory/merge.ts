import { many, one, query } from '../db/pool.js';
import { embedOne } from '../embedding/index.js';
import { log, errFields } from '../logger.js';

/**
 * 写入合并。
 *
 * 参照 Ombre-Brain 的 `_merge_or_create`：写之前先搜一次，
 * 太像就并进已有那条，不像才新建。
 *
 * 它们 `rule.md` 第 10 条说得很准：
 *   "自动合并的依据是**同一个具体事件的连续性**，不是日期是否相同。
 *    仅主题、人物或情绪相似不能合并。"
 *
 * 所以这里的门槛定得偏高（0.88），宁可多一条，不要错并一条 ——
 * 合并是自动的、看不见的，并错了她很难发现。
 */

/** 到这个相似度才认为是同一件事 */
const MERGE_SIMILARITY = 0.88;
/** 只在活跃记忆里找 */
const ACTIVE = "state in ('active', 'archived')";

export interface MergeInput {
  kind: string;
  content: string;
  quotes: { who: string; text: string }[];
  causal: string | null;
  eventTime: string | null;
  importance: number;
  via: string;
  /** 已经算好的向量；不传就现算 */
  embedding?: string | null;
}

export interface MergeOutcome {
  merged: boolean;
  memoryId: string | null;
  /** 并进去的那条原来的正文（给人看） */
  targetPreview?: string;
  similarity?: number;
}

function vectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`;
}

export async function mergeOrCreate(input: MergeInput): Promise<MergeOutcome> {
  let vec = input.embedding ?? null;
  if (!vec) {
    try {
      vec = vectorLiteral(await embedOne(input.content.slice(0, 2000)));
    } catch (err) {
      log.warn('合并前算向量失败，直接新建', errFields(err));
    }
  }

  // 找出最像的一条活跃记忆
  if (vec) {
    const hits = await many<{ id: string; content: string; similarity: string }>(
      `select id::text, content, (1 - (embedding <=> $1::vector))::text as similarity
         from memory_items
        where ${ACTIVE}
          and embedding is not null
          and not pinned
        order by embedding <=> $1::vector
        limit 1`,
      [vec],
    ).catch(() => []);

    const hit = hits[0];
    const sim = hit ? Number(hit.similarity) : 0;
    if (hit && sim >= MERGE_SIMILARITY) {
      return mergeInto(hit.id, hit.content, sim, input);
    }
  }

  return { merged: false, memoryId: null };
}

/** 并进目标条目：原文分隔追加、quotes 去重合并、重要度取大、时间取更早 */
async function mergeInto(
  targetId: string,
  targetContent: string,
  similarity: number,
  input: MergeInput,
): Promise<MergeOutcome> {
  try {
    await query(
      `update memory_items
          set content = content || $2 || $3,
              quotes = (
                select coalesce(jsonb_agg(distinct q), '[]'::jsonb)
                  from jsonb_array_elements(quotes || $4::jsonb) q
              ),
              causal = coalesce(causal, to_jsonb($5::text)),
              event_time = least(coalesce(event_time, $6::timestamptz), $6::timestamptz),
              importance = greatest(importance, $7),
              merge_count = merge_count + 1,
              updated_at = now()
        where id = $1::uuid`,
      [
        targetId,
        '\n\n———— 后来又说了一次 ————\n\n',
        input.content,
        JSON.stringify(input.quotes ?? []),
        input.causal,
        input.eventTime,
        input.importance,
      ],
    );

    // 留一条记录给她看："合并了告诉我"
    await query(
      `insert into memory_merges (target_id, similarity, merged_text, merged_quotes, via)
       values ($1::uuid, $2, $3, $4::jsonb, $5)`,
      [targetId, similarity, input.content, JSON.stringify(input.quotes ?? []), input.via],
    );

    log.info('这条太像了，并进已有记忆', {
      target: targetId.slice(0, 8),
      similarity: Number(similarity.toFixed(3)),
      via: input.via,
    });

    return {
      merged: true,
      memoryId: targetId,
      targetPreview: targetContent.slice(0, 60),
      similarity,
    };
  } catch (err) {
    log.warn('合并失败，退回新建', errFields(err));
    return { merged: false, memoryId: null };
  }
}

/** 未读的合并记录数（给前端小红点） */
export async function unseenMergeCount(): Promise<number> {
  const row = await one<{ n: number }>(`select count(*)::int as n from memory_merges where not seen`);
  return row?.n ?? 0;
}

export interface MergeRecord {
  id: string;
  at: string;
  similarity: number;
  mergedText: string;
  via: string;
  seen: boolean;
  targetId: string;
  targetPreview: string;
}

export async function listMerges(limit = 30): Promise<MergeRecord[]> {
  const rows = await many<{
    id: string;
    at: string;
    similarity: number;
    merged_text: string;
    via: string;
    seen: boolean;
    target_id: string;
    target_preview: string;
  }>(
    `select g.id::text, g.created_at as at, g.similarity, g.merged_text, g.via, g.seen,
            g.target_id::text, left(m.content, 80) as target_preview
       from memory_merges g
       join memory_items m on m.id = g.target_id
      order by g.created_at desc limit $1`,
    [limit],
  );
  return rows.map((r) => ({
    id: r.id,
    at: r.at,
    similarity: Number(r.similarity),
    mergedText: r.merged_text,
    via: r.via,
    seen: Boolean(r.seen),
    targetId: r.target_id,
    targetPreview: r.target_preview,
  }));
}

export async function markMergesSeen(ids?: string[]): Promise<void> {
  if (ids && ids.length > 0) {
    await query(`update memory_merges set seen = true where id = any($1::uuid[])`, [ids]);
    return;
  }
  await query(`update memory_merges set seen = true where not seen`);
}
