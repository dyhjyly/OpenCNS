import { many } from '../../db/pool.js';
import { log } from '../../logger.js';

/**
 * 衰减 v2 —— 记忆的"养护"里最基本的一件事。
 *
 * 构想里的原话：「按多久没想起沉底，而不是多久没被修改。
 *                常被想起的记忆保持鲜活，从没被想起的慢慢让位，彻底沉底，进行归档。」
 *
 * 关键设计：decay_score 是**纯函数**
 *     score = exp( - 距上次想起的天数 / 半衰期 )
 *     半衰期 = 10 + importance² × 400  天
 *        重要度 0.9 -> 约 334 天
 *        重要度 0.5 -> 约 110 天
 *        重要度 0.2 -> 约  26 天
 *
 * 为什么必须是纯函数：旧库那批 1e-201 的次正规浮点，就是"每天拿当前值再乘一次"
 * 复利式塌缩打出来的。纯函数每天重算都得到同样结果，天然幂等。
 *
 * "被想起"由 reinforce_memory 把 last_recalled_at 归零 —— 想起一次，鲜活一次。
 */

export interface DecayResult {
  rescored: number;
  archived: number;
  pruned: number;
  revivedPinned: number;
}

/** 沉底阈值：低于它就离开活跃池 */
const ARCHIVE_BELOW = 0.35;
/** 彻底沉底阈值：归档之后再低于它就剪枝（不删数据，只改状态） */
const PRUNE_BELOW = 0.12;

export async function runDecay(): Promise<DecayResult> {
  const started = Date.now();

  // 1) 重算全部非奠基记忆的鲜活度
  const rescored = await many<{ id: string }>(
    `update memory_items m
        set decay_score = greatest(0, least(1,
              exp(
                - (extract(epoch from (now() - coalesce(m.last_recalled_at, m.ingested_at))) / 86400.0)
                / (10 + m.importance * m.importance * 400)
              )
            )),
            updated_at = now()
      where m.state in ('active', 'archived')
        and not m.pinned
      returning m.id`,
  );

  // 2) 活跃 -> 归档
  const archived = await many<{ id: string }>(
    `update memory_items
        set state = 'archived', updated_at = now()
      where state = 'active' and not pinned and decay_score < $1
      returning id`,
    [ARCHIVE_BELOW],
  );

  // 3) 归档 -> 剪枝（数据仍在，只是不再被取用）
  const pruned = await many<{ id: string }>(
    `update memory_items
        set state = 'pruned', updated_at = now()
      where state = 'archived' and not pinned and decay_score < $1
      returning id`,
    [PRUNE_BELOW],
  );

  // 4) 奠基记忆永不衰减：强制鲜活、且必须在活跃池里
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
