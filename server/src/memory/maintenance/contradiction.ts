import { many, query } from '../../db/pool.js';
import { chatJson } from '../../llm/client.js';
import { log, errFields } from '../../logger.js';

/**
 * 矛盾处理 —— 构想原话：
 *   「新旧信息冲突不应删，打有向标签，新的覆盖旧的，旧记忆还在，只是不再被优先取用。」
 *
 * 所以这里从不删数据，只做两件事：
 *   1) 写一条 supersedes 有向边（新的 -> 旧的）
 *   2) 把旧的 state 置为 'superseded'（召回时已排除这个状态）
 */

const SIMILARITY_FLOOR = 0.68;

const JUDGE_SYSTEM_PROMPT = `你在判断新记忆是否**取代**了旧记忆。

"取代"的定义很严格：说的是同一件事或同一个方面，而新记忆提供了更新、更准确的说法
（例如：状态变了、决定改了、纠正了之前的错误）。

以下情况**不算**取代：
· 只是话题相近（都在讲她、都在讲工作）
· 是同一件事的补充细节（那应该并存）
· 时间不同、是先后发生的两件事
· 新的只是措辞不同但信息一样（那属于重复，不是取代）

只输出 JSON：
{ "supersedes": ["旧记忆的 id"], "reason": "一句话说明" }

没有取代关系时：{ "supersedes": [], "reason": "..." }`;

interface Candidate {
  id: string;
  content: string;
  similarity: number;
  event_time: string | null;
}

/**
 * 在写入一条新记忆之后调用。异步、失败不影响主流程。
 * @returns 被取代的旧记忆 id 列表
 */
export async function applySupersede(newId: string, newContent: string, label = 'episode'): Promise<string[]> {
  try {
    const candidates = await many<Candidate>(
      `select c.id, c.content, (1 - (c.embedding <=> n.embedding))::real as similarity, c.event_time
         from memory_items n
         join lateral (
           select id, content, embedding, event_time
             from memory_items x
            where x.id <> n.id
              and x.state in ('active','archived')
              and x.embedding is not null
            order by x.embedding <=> n.embedding
            limit 3
         ) c on true
        where n.id = $1 and n.embedding is not null`,
      [newId],
    );

    const relevant = candidates.filter((c) => c.similarity >= SIMILARITY_FLOOR);
    if (relevant.length === 0) return [];

    const list = relevant
      .map(
        (c, i) =>
          `${i + 1}. id=${c.id}  相似度=${c.similarity.toFixed(3)}  发生时间=${c.event_time ? new Date(c.event_time).toISOString().slice(0, 10) : '不详'}\n   ${c.content.slice(0, 500)}`,
      )
      .join('\n');

    const verdict = await chatJson<{ supersedes?: unknown; reason?: string }>(
      [
        { role: 'system', content: JUDGE_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `【新记忆】（${label}）\n${newContent.slice(0, 800)}\n\n【已有记忆】\n${list}\n\n新记忆是否取代了其中某几条？只输出 JSON。`,
        },
      ],
      { endpoint: 'cognitive', temperature: 0.1, maxTokens: 1500, label: 'supersede' },
    );

    const validIds = new Set(relevant.map((c) => c.id));
    const targets = Array.isArray(verdict.supersedes)
      ? verdict.supersedes.filter((id): id is string => typeof id === 'string' && validIds.has(id))
      : [];

    if (targets.length === 0) {
      log.debug('无取代关系', { newId, reason: verdict.reason });
      return [];
    }

    for (const oldId of targets) {
      await query(
        `insert into memory_edges (from_id, to_id, relation, weight)
         values ($1, $2, 'supersedes', 1.0)
         on conflict (from_id, to_id, relation) do nothing`,
        [newId, oldId],
      );
      await query(
        `update memory_items
            set state = 'superseded', superseded_by = $2, updated_at = now()
          where id = $1 and state <> 'superseded'`,
        [oldId, newId],
      );
    }

    log.info('新旧冲突已打有向标签（旧记忆仍在，只是不再优先取用）', {
      newId,
      superseded: targets.length,
      reason: verdict.reason,
    });
    return targets;
  } catch (err) {
    log.error('矛盾处理失败（不影响主流程）', errFields(err));
    return [];
  }
}
