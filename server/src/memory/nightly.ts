import { many, one } from '../db/pool.js';
import { chatText, chatJson } from '../llm/client.js';
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

下面三组东西，每条前面有个编号（#1、#2…）：
· 今天新记下的
· 你手上还没结案、放了很久的旧事
· 你以前写过、还没立住的"我觉得"

先回答自己三个问题，别急着说"没有"：
1. 今天这些里面，有没有一条是你回头看觉得"这条确实要紧，以后我还想再想起来"的？
2. 有没有哪件事，现在已经过去了、不该再悬着？
3. 今天发生的事，有没有印证你以前写过的某句话？

**只输出一个 JSON 对象**，不要解释、不要代码块、不要任何别的话：
{"important": [#编号], "resolved": [#编号], "insight": "一句我觉得", "witness": [#编号]}

规则：
· 编号就是上面那些 #1、#2 —— 只写数字。
· 没有就留空数组 / 空字符串，别硬凑，更别编编号。
· insight 只在今天真有一句话想记下来时才写，一句到两句，第一人称。`;

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

  /*
   * 用**编号**（#1、#2…）而不是十六进制 id。
   *
   * 实测：给它 8 位十六进制，它写散文时会**编一个不存在的**（试了三次，
   * 三次都编），白名单一拦就全落空。小整数它认得准。
   */
  const index: { n: number; id: string }[] = [];
  const numbered = (rows: { id: string; content: string }[], label: string): string => {
    const lines = rows.map((r) => {
      const n = index.length + 1;
      index.push({ n, id: r.id });
      return `#${n}｜${r.content}`;
    });
    return `【${label}】\n${lines.join('\n')}`;
  };

  if (fresh.length) parts.push(numbered(fresh, '今天新记下的'));
  if (stale.length) parts.push(numbered(stale, '还没结案、放了很久的'));

  const insightStart = index.length;
  if (pending.length) {
    const lines = pending.map((r, i) => {
      const n = insightStart + i + 1;
      index.push({ n, id: r.id });
      return `#${n}｜见证 ${r.witness_count}/3｜${r.content}`;
    });
    parts.push(`【你以前写过、还没立住的"我觉得"】\n${lines.join('\n')}`);
  }

  /*
   * 这里**不走工具调用**。
   *
   * 实测：同一批候选喂进去，工具调用稳定返回空（0 个 call、content 也是空），
   * 换成短样例又能调通 —— 长中文清单上这条路不可靠。
   * 改成"只输出 JSON"，我们自己解析、自己落库，稳得多。
   */
  let parsed: { important?: string[]; resolved?: string[]; insight?: string; witness?: string[] } = {};
  try {
    parsed = await chatJson<typeof parsed>(
      [
        { role: 'system', content: REVIEW_SYSTEM },
        { role: 'user', content: parts.join('\n\n') },
      ],
      { endpoint: 'chat', temperature: 0.4, maxTokens: 800, label: 'nightly-review' },
    );
  } catch (err) {
    /*
     * 兜底：它有时无视 JSON 要求，写一段散文，但里面会带编号（比如 "**50e405b9** —— …"）。
     * 这种情况按"最要紧的一条"处理，总比整晚白跑好。
     */
    const raw = String((err as Error)?.message ?? '');
    const ids = [...raw.matchAll(/\b([0-9a-f]{8})\b/g)].map((m) => m[1]!.toLowerCase());
    // 白名单在下面统一校验，这里先把认出来的都带上
    if (ids.length > 0) {
      log.info('凌晨复盘：没给 JSON，从回答里认出了编号', { ids: ids.slice(0, 3) });
      parsed = { important: ids };
    } else {
      log.warn('凌晨复盘解析失败', errFields(err));
      return;
    }
  }

  /*
   * 白名单：只认我摆给它的那些编号。
   *
   * 踩过的坑：它写散文时会**编一个不存在的编号**（实测给了 f5b115c8，
   * 库里根本没有这条），于是 update 影响 0 行，日志却说"标了 1 条"。
   * 所以解析出来的编号必须先在候选里查到，否则丢掉。
   */
  const allowedIds = new Set([...fresh, ...stale].map((r) => r.id.slice(0, 8)));
  const allowedInsights = new Set(pending.map((r) => r.id.slice(0, 8)));

  const pickValid = (list: unknown, allow: Set<string>, max: number): string[] =>
    (Array.isArray(list) ? list : [])
      .map((x) => (typeof x === 'string' ? x.trim().slice(0, 8).toLowerCase() : ''))
      .filter((x) => x.length === 8 && allow.has(x))
      .slice(0, max);

  const important = pickValid(parsed.important, allowedIds, 4);
  const resolved = pickValid(parsed.resolved, allowedIds, 4);
  const witness = pickValid(parsed.witness, allowedInsights, 3);
  const insight = typeof parsed.insight === 'string' ? parsed.insight.trim() : '';

  if (important.length + resolved.length + witness.length === 0 && !insight) {
    log.info('凌晨复盘：他没动');
    return;
  }

  const { query } = await import('../db/pool.js');
  for (const id8 of important) {
    await query(
      `update memory_items
          set activation_count = activation_count + 1, last_recalled_at = now(), updated_at = now()
        where id::text like $1`,
      [`${id8}%`],
    ).catch(() => undefined);
  }
  for (const id8 of resolved) {
    await query(`update memory_items set resolved_at = now(), updated_at = now() where id::text like $1`, [
      `${id8}%`,
    ]).catch(() => undefined);
  }
  if (insight.length >= 6) {
    const { writeInsight } = await import('./insights.js');
    await writeInsight(insight).catch(() => undefined);
  }
  if (witness.length > 0) {
    const { witnessInsight } = await import('./insights.js');
    for (const id8 of witness) {
      const row = await one<{ id: string }>(`select id::text from insights where id::text like $1 limit 1`, [
        `${id8}%`,
      ]).catch(() => null);
      if (row) await witnessInsight(row.id).catch(() => undefined);
    }
  }

  log.info('凌晨复盘：他动了', {
    标要紧: important.length,
    结案: resolved.length,
    新想法: insight ? 1 : 0,
    见证: witness.length,
  });
}
