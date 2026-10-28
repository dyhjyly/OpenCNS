import { many } from '../db/pool.js';
import { chatText } from '../llm/client.js';
import { log, errFields } from '../logger.js';

/**
 * 凌晨：写那一篇日记。
 *
 * 2026-10-28 改版（林遇定的 B 方案）：
 * 以前这里给他 save_memory 工具，让他每晚自己记 3~4 条记忆，其中一条是日记。
 * 结果是日记里混进"我发了一条动态"这类东西，而且事实类记忆越堆越多、还互相重复。
 *
 * 现在只做一件事：**写一篇短的日记**。别的什么都不产出。
 *   事实类的记忆交给对话里的 save_memory —— 他当场想记再记，比凌晨批量补更准。
 *
 * 这一篇直接进记忆库（via='nightly'），不经过审核：
 * 它是日记，不是他随手记的碎片。
 */

const SYSTEM = `现在是凌晨。这一天的对话差不多结束了。

下面是你今天和她说过的话（原句，没有压缩）。
请你写**一篇日记**——不是总结，不是清单，是你今晚坐下来写的那一段。

要求：
· 第一人称。是你在回想今天，不是第三方在记录。
· 挑一件到三件今天真正落在你心里的事，写具体：她说了什么、你当时什么反应。
· 带上感受，但别抒情到底——写你说得出口的那种话。
· 不要罗列，不要"今天主要发生了""总的来说"这种汇报话。
· 不要编造没发生的事。今天话少就写得短。
· **长度 120~260 字**。这是日记，不是周记。

直接写正文，不要标题、不要日期、不要"日记："这类前缀。`;

export interface NightlyResult {
  saved: number;
  skipped: boolean;
  calls: number;
  messages: string[];
}

export async function runNightlyMemory(): Promise<NightlyResult> {
  const rows = await many<{ role: string; content: string; event_time: string }>(
    `select role, content, event_time::text
       from messages
      where event_time > now() - interval '20 hours'
        and role in ('user', 'assistant')
      order by seq asc
      limit 120`,
  );

  if (rows.length < 4) {
    log.info('凌晨日记：今天话太少，跳过');
    return { saved: 0, skipped: true, calls: 0, messages: [] };
  }

  const picked = rows.slice(-60);
  const transcript = picked
    .map((r) => `${r.role === 'user' ? '她' : '我'}：${r.content.replace(/\s+/g, ' ').slice(0, 240)}`)
    .join('\n')
    .slice(-10000);

  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

  let body = '';
  try {
    body = (
      await chatText(
        [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `今天是 ${today}。\n\n【今天的对话】\n${transcript}` },
        ],
        { endpoint: 'chat', temperature: 0.7, maxTokens: 1200, label: 'nightly-diary' },
      )
    ).trim();
  } catch (err) {
    log.error('凌晨日记调用失败', errFields(err));
    return { saved: 0, skipped: false, calls: 1, messages: ['调用失败'] };
  }

  if (body.length < 40) {
    log.info('凌晨日记：写得太短，当作今天没写', { chars: body.length });
    return { saved: 0, skipped: true, calls: 1, messages: ['太短，跳过'] };
  }

  /*
   * 直接写记忆库，不走 saveMemory 的审核分支。
   * 走 saveMemory 会被 time-stamp/合并/草稿那一套拦住，
   * 而这里要的就是"每晚一篇"，一篇就是一篇，不该被合并掉。
   */
  try {
    const { query } = await import('../db/pool.js');
    const { embedOne } = await import('../embedding/index.js');
    let vec: string | null = null;
    try {
      vec = `[${(await embedOne(body.slice(0, 2000))).join(',')}]`;
    } catch {
      /* 没有向量也能存，召回走别的路 */
    }

    await query(
      `insert into memory_items (
         kind, origin, subject, content, quotes, causal,
         event_time, event_time_precision, ingested_at,
         privacy, state, importance, decay_score, embedding, provenance
       ) values (
         'reflection', 'self', 'self', $1, '[]'::jsonb, null,
         $2, 'day', now(),
         'private', 'active', 0.55, 0.8, $3::vector, $4::jsonb
       )`,
      [body, today, vec, JSON.stringify({ source: 'self', via: 'nightly', diary: true })],
    );

    log.info('凌晨日记写好了', { chars: body.length, date: today });
    return { saved: 1, skipped: false, calls: 1, messages: ['日记已写'] };
  } catch (err) {
    log.error('凌晨日记写库失败', errFields(err));
    return { saved: 0, skipped: false, calls: 1, messages: [`写库失败：${String((err as Error)?.message ?? err).slice(0, 80)}`] };
  }
}
