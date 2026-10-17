import { many, query } from '../../db/pool.js';
import { chatJson } from '../../llm/client.js';
import { log, errFields } from '../../logger.js';

/**
 * 去重与降噪。
 *
 * 构想原话：
 *   去重：「向量相似不等于内容重复。最终判定必须过 LLM 语义层，纯阈值判定会误删。」
 *   降噪：「每条记忆进入记忆库都有门槛。碎片，口水文字不进去，历史遗留的模板卡定期清理。」
 *
 * 所以：
 *   · 向量只用来**找候选**，判定一律过 LLM；
 *   · 合并时保留信息量更大的那条（带引语的、更长的），另一条标 merged_into，数据不删。
 */

const PAIR_FLOOR = 0.90;
const MAX_PAIRS_PER_RUN = 8;

const JUDGE_SYSTEM_PROMPT = `你在判断两条记忆是不是**同一条**。

"同一条"的定义：说的是同一件事、同一个事实，只是措辞或详略不同。

不算同一条的情况：
· 同一件事的不同侧面（例如"她去了医院"和"医生说要半年复查"）
· 时间不同、是先后发生的两次
· 一条是另一条的延伸或后果

只输出 JSON：{ "same": true 或 false, "keep": "保留哪条的 id", "reason": "一句话" }`;

export interface DedupeResult {
  pairsChecked: number;
  merged: number;
  reasons: string[];
}

export async function runDedupe(): Promise<DedupeResult> {
  const started = Date.now();
  const result: DedupeResult = { pairsChecked: 0, merged: 0, reasons: [] };

  // 候选对：每条记忆找最近邻，相似度过阈值的才算候选
  const pairs = await many<{ a_id: string; a_content: string; b_id: string; b_content: string; sim: number }>(
    `select a.id as a_id, a.content as a_content, b.id as b_id, b.content as b_content, b.sim
       from memory_items a
       join lateral (
         select c.id, c.content, (1 - (c.embedding <=> a.embedding))::real as sim
           from memory_items c
          where c.id <> a.id
            and c.state in ('active','archived')
            and c.embedding is not null
          order by c.embedding <=> a.embedding
          limit 1
       ) b on true
      where a.state in ('active','archived')
        and a.embedding is not null
        and b.sim >= $1
      order by b.sim desc
      limit $2`,
    [PAIR_FLOOR, MAX_PAIRS_PER_RUN],
  );

  for (const p of pairs) {
    result.pairsChecked++;
    try {
      const verdict = await chatJson<{ same?: boolean; keep?: string; reason?: string }>(
        [
          { role: 'system', content: JUDGE_SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              `【A】id=${p.a_id}\n${p.a_content.slice(0, 700)}`,
              '',
              `【B】id=${p.b_id}\n${p.b_content.slice(0, 700)}`,
              '',
              `相似度 ${p.sim.toFixed(3)}。它们是同一条吗？只输出 JSON。`,
            ].join('\n'),
          },
        ],
        { endpoint: 'cognitive', temperature: 0.1, maxTokens: 1200, label: 'dedupe' },
      );

      if (!verdict.same) continue;

      // 保留信息量更大的那条（长文优先，带引语的优先）
      const keepId = verdict.keep === p.a_id || verdict.keep === p.b_id
        ? verdict.keep
        : p.a_content.length >= p.b_content.length
          ? p.a_id
          : p.b_id;
      const dropId = keepId === p.a_id ? p.b_id : p.a_id;

      await query(
        `insert into memory_edges (from_id, to_id, relation, weight)
         values ($1, $2, 'similar', 1.0)
         on conflict (from_id, to_id, relation) do nothing`,
        [keepId, dropId],
      );
      await query(
        `update memory_items set state = 'merged_into', merged_into = $2, updated_at = now()
          where id = $1 and state <> 'merged_into'`,
        [dropId, keepId],
      );

      result.merged++;
      result.reasons.push(`合并 ${dropId.slice(0, 8)} -> ${keepId.slice(0, 8)}：${verdict.reason ?? ''}`);
    } catch (err) {
      log.error('去重判定失败（跳过这一对）', errFields(err));
    }
  }

  log.info('去重完成', { ...result, ms: Date.now() - started });
  return result;
}

/**
 * 降噪：清理历史遗留的模板卡 / 测试文本。
 * 只看**确凿无疑**的模式，模糊的一律不碰 —— 关键词判定误杀过一次（88 条里只有 3 条是真垃圾）。
 */
export async function runNoiseScan(): Promise<{ pruned: number; flagged: number }> {
  const pruned = await many<{ id: string }>(
    `update memory_items
        set state = 'pruned', updated_at = now()
      where state in ('active','archived')
        and not pinned
        and (
          content ~* '^\\s*(测试|test|route_test)'
          or content like '%检查记忆库连接是否正常%'
        )
      returning id`,
  );

  const flagged = await many<{ id: string; content: string }>(
    `select id, content from memory_items
      where state in ('active','archived')
        and (
          content like 'Dream Review Summary:%'
          or content like 'Long-term identity reflection:%'
          or char_length(content) < 10
        )
      limit 50`,
  );

  if (pruned.length > 0) log.info('降噪：已剪枝确凿的模板/测试文本', { count: pruned.length });
  if (flagged.length > 0) {
    log.info('降噪：以下条目可疑但未处理，留待人工过目', {
      count: flagged.length,
      samples: flagged.slice(0, 5).map((f) => f.content.slice(0, 50)),
    });
  }

  return { pruned: pruned.length, flagged: flagged.length };
}
