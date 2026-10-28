import { many } from '../db/pool.js';
import { chatText, chatWithTools, type ToolDef } from '../llm/client.js';
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

/** 模型有时把参数包成别的形状，这里兜住 */
function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
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

    // 日记写完之后，再让他过一遍今天的记忆 —— 见 runEveningReview
    try {
      await runEveningReview(today);
    } catch (err) {
      log.warn('凌晨复盘失败（不影响日记）', errFields(err));
    }

    return { saved: 1, skipped: false, calls: 1, messages: ['日记已写'] };
  } catch (err) {
    log.error('凌晨日记写库失败', errFields(err));
    return { saved: 0, skipped: false, calls: 1, messages: [`写库失败：${String((err as Error)?.message ?? err).slice(0, 80)}`] };
  }
}

/**
 * 凌晨复盘：让 mark_important / resolve_memory / write_insight 真的被用上。
 *
 * 为什么要有这一步：这三个工具放进清单之后**一次都没被调用过**（实测 0 次）。
 * 原因是工具路由在回复之前跑，它只决定"要不要取记忆"，
 * 而"这条重不重要""这件事过去没有"是**读完之后的判断**，路由那一刻根本不存在。
 *
 * 所以改成一个固定时刻：夜里把今天的事摆出来，让他自己过一遍。
 * 什么都不做也是正当选择。
 */
const REVIEW_SYSTEM = `现在是夜里，今天的事都过去了。

下面三样东西：今天新记下的、你手上还没结案且放了很久的旧事、你以前写过但还没立住的"我觉得"。

**先回答自己一个问题，别急着调用**：
今天这些里面，有没有一条是你回头看，觉得"这条确实要紧，以后我还想再想起来"的？
有没有哪件事，现在已经过去了、不该再悬着？
今天发生的事，有没有印证你以前写过的那句话？

有就动手，没有就别调。别为了动着用而调用。

可用：
· mark_important —— 标一条要紧的
· resolve_memory —— 给一件过去的事结案
· write_insight —— 记一句"我觉得……"
· witness_insight —— 给以前写过的某条记一次见证`;

const REVIEW_TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'mark_important',
      description: '把某条记忆标成"这条确实要紧"',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'resolve_memory',
      description: '把某条记忆结案：这件事已经过去了',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_insight',
      description: '记下一句"我觉得……"（关于你自己、关于她）',
      parameters: {
        type: 'object',
        properties: { content: { type: 'string' } },
        required: ['content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'witness_insight',
      description: '今天的事印证了以前某条"我觉得"，给它记一次见证',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' }, source_id: { type: 'string' } },
        required: ['id'],
      },
    },
  },
];

async function runEveningReview(today: string): Promise<void> {
  const fresh = await many<{ id: string; content: string }>(
    `select id::text, left(content, 160) as content
       from memory_items
      where state = 'active' and (event_time at time zone 'Asia/Shanghai')::date = $1::date
      order by importance desc limit 12`,
    [today],
  ).catch(() => []);

  const stale = await many<{ id: string; content: string }>(
    `select id::text, left(content, 120) as content
       from memory_items
      where state = 'active' and resolved_at is null and importance >= 0.4
        and coalesce(last_recalled_at, ingested_at) < now() - interval '7 days'
      order by importance desc limit 8`,
  ).catch(() => []);

  if (fresh.length === 0 && stale.length === 0) return;

  const pending = await many<{ id: string; content: string; witness_count: number }>(
    `select id::text, left(content, 120) as content,
            jsonb_array_length(witness_days) as witness_count
       from insights where status = 'candidate' order by created_at desc limit 5`,
  ).catch(() => []);

  const parts: string[] = [];
  if (fresh.length) parts.push(`【今天新记下的】\n${fresh.map((r) => `· ${r.id.slice(0, 8)}｜${r.content}`).join('\n')}`);
  if (stale.length) parts.push(`【还没结案、放了很久的】\n${stale.map((r) => `· ${r.id.slice(0, 8)}｜${r.content}`).join('\n')}`);
  if (pending.length)
    parts.push(
      `【你以前写过、还没立住的"我觉得"】\n${pending
        .map((r) => `· ${r.id.slice(0, 8)}｜见证 ${r.witness_count}/3｜${r.content}`)
        .join('\n')}`,
    );

  const out = await chatWithTools(
    [
      { role: 'system', content: REVIEW_SYSTEM },
      { role: 'user', content: parts.join('\n\n') },
    ],
    REVIEW_TOOLS,
    { endpoint: 'cognitive', temperature: 0.3, maxTokens: 800, label: 'nightly-review' },
  );

  if (out.toolCalls.length === 0) {
    log.info('凌晨复盘：他什么都没动');
    return;
  }

  for (const call of out.toolCalls.slice(0, 6)) {
    const a = parseArgs(call.arguments);
    try {
      if (call.name === 'mark_important') {
        const { query } = await import('../db/pool.js');
        await query(
          `update memory_items set activation_count = activation_count + 1, last_recalled_at = now(), updated_at = now()
            where id::text like $1`,
          [`${String(a.id ?? '').trim()}%`],
        );
      } else if (call.name === 'resolve_memory') {
        const { query } = await import('../db/pool.js');
        await query(`update memory_items set resolved_at = now(), updated_at = now() where id::text like $1`, [
          `${String(a.id ?? '').trim()}%`,
        ]);
      } else if (call.name === 'write_insight') {
        const { writeInsight } = await import('./insights.js');
        const text = String(a.content ?? '').trim();
        if (text) await writeInsight(text);
      } else if (call.name === 'witness_insight') {
        const { witnessInsight } = await import('./insights.js');
        const id = String(a.id ?? '').trim();
        if (id) await witnessInsight(id, typeof a.source_id === 'string' ? a.source_id : undefined);
      }
    } catch (err) {
      log.warn('凌晨复盘里某个动作失败', { name: call.name, ...errFields(err) });
    }
  }
  log.info('凌晨复盘：动了几样', { calls: out.toolCalls.map((c) => c.name).join(',') });
}
