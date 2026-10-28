import { many } from '../../db/pool.js';
import { log } from '../../logger.js';

/**
 * 衰减 v3 —— 参照 Ombre-Brain 的 calculate_score 改写。
 *
 * 他们的公式：
 *   final = importance × activation^0.3 × e^(-λ·天数) × combined_weight
 *           × resolved_factor × urgency_boost
 *
 * 其中最有价值的是**权重分段**：
 *   · 短期（≤3 天）：时间 0.7 / 情感 0.3（近事优先）
 *   · 长期（>3 天）：情感 0.7 / 时间 0.3（感情深的留得久）
 *
 * 和 v2 的区别：
 *   1. 引入 activation_count —— **检索不再加分**，只有明确的"这条要紧"才加
 *   2. 引入 resolved —— 事情过去了权重 ×0.05，沉底但不删除
 *   3. 引入 urgency —— 情绪还很激动且没结案，×1.5
 *
 * 仍然是**纯函数**：每天全量重算，天然幂等（旧库那批 1e-201 的次正规浮点
 * 就是"拿当前值再乘一次"的复利塌缩打出来的）。
 */

export interface DecayResult {
  rescored: number;
  autoResolved: number;
  archived: number;
  pruned: number;
  revivedPinned: number;
}

/** 沉底阈值：低于它就离开活跃池 */
const ARCHIVE_BELOW = 0.35;
/** 彻底沉底阈值：归档之后再低于它就剪枝（不删数据，只改状态） */
const PRUNE_BELOW = 0.12;
/** 自动结案：重要度低于这条线、且超过这么多天没结案 */
const AUTO_RESOLVE_MAX_IMPORTANCE = 0.4;
const AUTO_RESOLVE_AFTER_DAYS = 30;

export async function runDecay(): Promise<DecayResult> {
  const started = Date.now();

  // 1) 自动结案：不重要、又放了很久，就当它过去了
  const autoResolved = await many<{ id: string }>(
    `update memory_items
        set resolved_at = now(), updated_at = now()
      where state = 'active'
        and not pinned
        and resolved_at is null
        and importance <= $1
        and coalesce(last_recalled_at, ingested_at) < now() - make_interval(days => $2)
      returning id`,
    [AUTO_RESOLVE_MAX_IMPORTANCE, AUTO_RESOLVE_AFTER_DAYS],
  );

  // 2) 重算全部非奠基记忆的鲜活度（纯函数，全量重算）
  const rescored = await many<{ id: string }>(
    `update memory_items m
        set decay_score = least(1.0, greatest(0.0,
              m.importance
              * power(1 + m.activation_count, 0.3)
              * exp(
                  - (extract(epoch from (now() - coalesce(m.resolved_at, m.last_recalled_at, m.ingested_at))) / 86400.0)
                  / (10 + m.importance * m.importance * 400)
                )
              * (
                  case
                    when extract(epoch from (now() - coalesce(m.last_recalled_at, m.ingested_at))) / 86400.0 <= 3
                      then (1.0 + exp(-extract(epoch from (now() - coalesce(m.last_recalled_at, m.ingested_at))) / 129600.0)) * 0.7
                         + (1.0 + coalesce(m.emotion_arousal, 0) * 0.8) * 0.3
                    else (1.0 + coalesce(m.emotion_arousal, 0) * 0.8) * 0.7
                         + (1.0 + exp(-extract(epoch from (now() - coalesce(m.last_recalled_at, m.ingested_at))) / 129600.0)) * 0.3
                  end
                ) / 1.7
              * (case when m.resolved_at is not null then 0.05 else 1.0 end)
              * (case when coalesce(m.emotion_arousal, 0) > 0.7 and m.resolved_at is null then 1.5 else 1.0 end)
            )),
            updated_at = now()
      where m.state in ('active', 'archived')
        and not m.pinned
      returning m.id`,
  );

  // 3) 活跃 -> 归档
  const archived = await many<{ id: string }>(
    `update memory_items
        set state = 'archived', updated_at = now()
      where state = 'active' and not pinned and decay_score < $1
      returning id`,
    [ARCHIVE_BELOW],
  );

  // 4) 归档 -> 剪枝（数据仍在，只是不再被取用）
  const pruned = await many<{ id: string }>(
    `update memory_items
        set state = 'pruned', updated_at = now()
      where state = 'archived' and not pinned and decay_score < $1
      returning id`,
    [PRUNE_BELOW],
  );

  // 5) 奠基记忆永不衰减：强制鲜活、且必须在活跃池里
  //
  // 注意：**pruned 不能复活**。
  // 踩过的坑：这里原来写的是 `state in ('archived','pruned')` 就改回 active，
  // 结果她（或脚本）删掉的记忆，只要被访问一次就自己爬回记忆库 ——
  // 人格种子那 5 条就是这样又冒出来的。pruned 是"她决定不要了"，不是"沉底"。
  const pinned = await many<{ id: string }>(
    `update memory_items
        set decay_score = 1.0,
            state = case when state = 'archived' then 'active' else state end,
            updated_at = now()
      where pinned and state <> 'pruned' and (decay_score < 1.0 or state <> 'active')
      returning id`,
  );

  const result: DecayResult = {
    rescored: rescored.length,
    autoResolved: autoResolved.length,
    archived: archived.length,
    pruned: pruned.length,
    revivedPinned: pinned.length,
  };

  log.info('衰减完成', { ...result, ms: Date.now() - started });

  if (result.archived > 0) {
    log.info('有记忆沉底归档（仍可被检索到，只是不再优先取用）', { count: result.archived });
  }

  return result;
}
