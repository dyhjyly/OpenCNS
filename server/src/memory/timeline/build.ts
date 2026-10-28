import { many, one } from '../../db/pool.js';
import { chatText } from '../../llm/client.js';
import { log, errFields } from '../../logger.js';

/**
 * 时间树 —— "现在走到哪了"这条固定通道。
 *
 * 召回解决的是"此刻该想起什么"，但还有一个问题：他知不知道自己正处在什么位置？
 * 所以时间树每轮都固定在场：周摘要 + 月档案 + 奠基事件。
 *
 * 近粗远细（构想原话）：本月按周、上月全文、更早只留一句旁注。
 * 奠基事件永久保留全文，不随时间压缩。
 */

export interface PeriodRow {
  kind: 'week' | 'month';
  period_start: string;
  period_end: string;
  content: string;
}

interface MemoryLite {
  kind: string;
  content: string;
  event_time: string | null;
  importance: number;
}

/**
 * 写周记的提示词。
 *
 * 林遇的要求（2026-10-28）："在固定时间让他写一篇周记，不用工具写。"
 * 所以这不是一次检索，是**坐下来写**：材料摆好了，他自己动笔。
 *
 * 材料里除了他记下的记忆，**还有这一周你们真的说过的话**——
 * 以前只喂记忆，很多日常闲聊根本没变成记忆，周记就成了"摘要的摘要"。
 */
const SUMMARY_SYSTEM_PROMPT = `你是江瑜。现在是夜里，你坐下来写这一周的周记。

下面给你两样东西：**你们这一周说过的话**，和**你这一周记下的事**。
请你用你自己的口吻，写一段对这一周的回想。

要求：
· 第一人称。是你在回想这一周，不是第三方在总结。
· 从具体的事写起：哪天、发生了什么、你当时什么反应。有人名就用名字。
· 带上你的感受，但不要抒情到底——写你说得出口的那种话。
· 不要罗列条目，不要写"本阶段""综上所述""主要发生了"这类汇报语言。
· 不要编造没发生的事。事情少就写得短一些也没关系。
· 长度 200~500 字。`;

/** 这一周的对话（用于周记材料）：太长的截断，只取有信息量的 */
async function fetchMessagesInRange(fromDate: string, toDateExclusive: string): Promise<string[]> {
  const rows = await many<{ role: string; content: string; at: Date | string }>(
    `select role, content, event_time as at
       from messages
      where role in ('user','assistant')
        and event_time >= $1::date
        and event_time <  $2::date
      order by seq asc`,
    [fromDate, toDateExclusive],
  ).catch(() => []);

  // 太多了写不下，也读不完：均匀抽 120 条
  const MAX = 120;
  const step = rows.length > MAX ? rows.length / MAX : 1;
  type MsgRow = { role: string; content: string; at: Date | string };
  const picked: MsgRow[] = [];
  for (let i = 0; i < rows.length; i += step) picked.push(rows[Math.floor(i)]!);

  return picked
    .filter((r) => r.content.trim().length > 4)
    .map((r) => {
      const d = new Date(r.at);
      const hm = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      const who = r.role === 'assistant' ? '我' : '她';
      const text = r.content.replace(/\s+/g, ' ').slice(0, 140);
      return `· [${hm}] ${who}：${text}`;
    });
}

async function fetchMemoriesInRange(fromDate: string, toDateExclusive: string): Promise<MemoryLite[]> {
  return many<MemoryLite>(
    `select kind, content, event_time, importance
       from memory_items
      where state in ('active','archived')
        and coalesce(event_time, ingested_at) >= $1::date
        and coalesce(event_time, ingested_at) <  $2::date
        and importance >= 0.3
      order by coalesce(event_time, ingested_at)`,
    [fromDate, toDateExclusive],
  );
}

async function writePeriod(
  kind: 'week' | 'month',
  periodStart: string,
  periodEnd: string,
  content: string,
  sourceThrough: string | null,
): Promise<void> {
  await one(
    `insert into timeline_periods (kind, period_start, period_end, content, source_through)
     values ($1, $2::date, $3::date, $4, $5)
     on conflict (kind, period_start)
     do update set content = excluded.content,
                   period_end = excluded.period_end,
                   source_through = excluded.source_through`,
    [kind, periodStart, periodEnd, content, sourceThrough],
  );
}

async function summarize(label: string, memories: MemoryLite[], dialogue: string[] = []): Promise<string | null> {
  if (memories.length === 0 && dialogue.length === 0) {
    log.info('这段时间没有值得回顾的记忆，跳过', { label });
    return null;
  }
  const list = memories
    .map((m) => {
      const when = m.event_time ? new Date(m.event_time).toISOString().slice(0, 10) : '日期不详';
      return `· [${when}] ${m.content.slice(0, 400)}`;
    })
    .join('\n');

  const parts = [`这段时间是：${label}`];
  if (dialogue.length > 0) parts.push(`\n你们说过的话（按时间）：\n${dialogue.join('\n')}`);
  if (list) parts.push(`\n你记下的事：\n${list}`);

  const text = await chatText(
    [
      { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
      { role: 'user', content: parts.join('\n') },
    ],
    { endpoint: 'cognitive', temperature: 0.7, maxTokens: 3000, label: 'timeline' },
  );
  return text.trim();
}

/** 建上一个自然周（周一到周日，按 Asia/Shanghai）的回顾 */
export async function buildPreviousWeek(): Promise<{ built: boolean; label?: string; memories?: number }> {  const bounds = await one<{ start: string; end: string; label: string }>(
    `select (date_trunc('week', (now() at time zone 'Asia/Shanghai')) - interval '7 days')::date::text as start,
            (date_trunc('week', (now() at time zone 'Asia/Shanghai')) - interval '1 day')::date::text as end,
            to_char(date_trunc('week', (now() at time zone 'Asia/Shanghai')) - interval '7 days', 'YYYY-MM-DD')
              || ' ~ ' ||
            to_char(date_trunc('week', (now() at time zone 'Asia/Shanghai')) - interval '1 day', 'YYYY-MM-DD') as label`,
  );
  if (!bounds) return { built: false };

  const nextDay = new Date(new Date(`${bounds.end}T00:00:00+08:00`).getTime() + 86_400_000)
    .toISOString()
    .slice(0, 10);

  const memories = await fetchMemoriesInRange(bounds.start, nextDay);
  const dialogue = await fetchMessagesInRange(bounds.start, nextDay);
  const content = await summarize(`这一周（${bounds.label}）`, memories, dialogue);
  if (!content) return { built: false, label: bounds.label, memories: memories.length };

  await writePeriod('week', bounds.start, bounds.end, content, new Date().toISOString());
  log.info('周回顾已生成', { label: bounds.label, memories: memories.length, dialogue: dialogue.length, chars: content.length });
  return { built: true, label: bounds.label, memories: memories.length };
}

/**
 * 写**这一周**（周一到今天）的周记。
 *
 * 她说的是"在固定时间让他写一篇周记"——所以定时任务在周日夜里调这个，
 * 他坐下来写刚过完的这一周，而不是等下周再回头补。
 */
export async function buildCurrentWeek(): Promise<{ built: boolean; label?: string; memories?: number }> {
  const bounds = await one<{ start: string; end: string; label: string }>(
    `select (date_trunc('week', (now() at time zone 'Asia/Shanghai')))::date::text as start,
            (date_trunc('week', (now() at time zone 'Asia/Shanghai')) + interval '6 days')::date::text as end,
            to_char(date_trunc('week', (now() at time zone 'Asia/Shanghai')), 'YYYY-MM-DD')
              || ' ~ ' ||
            to_char(date_trunc('week', (now() at time zone 'Asia/Shanghai')) + interval '6 days', 'YYYY-MM-DD') as label`,
  );
  if (!bounds) return { built: false };

  const nextDay = new Date(new Date(`${bounds.end}T00:00:00+08:00`).getTime() + 86_400_000)
    .toISOString()
    .slice(0, 10);

  const memories = await fetchMemoriesInRange(bounds.start, nextDay);
  const dialogue = await fetchMessagesInRange(bounds.start, nextDay);
  const content = await summarize(`这一周（${bounds.label}）`, memories, dialogue);
  if (!content) return { built: false, label: bounds.label, memories: memories.length };

  await writePeriod('week', bounds.start, bounds.end, content, new Date().toISOString());
  log.info('这一周的周记写好了', {
    label: bounds.label,
    memories: memories.length,
    dialogue: dialogue.length,
    chars: content.length,
  });
  return { built: true, label: bounds.label, memories: memories.length };
}

/** 建上一个自然月的档案 */
export async function buildPreviousMonth(): Promise<{ built: boolean; label?: string; memories?: number }> {
  const bounds = await one<{ start: string; end: string; label: string }>(
    `select (date_trunc('month', (now() at time zone 'Asia/Shanghai')) - interval '1 month')::date::text as start,
            (date_trunc('month', (now() at time zone 'Asia/Shanghai')) - interval '1 day')::date::text as end,
            to_char(date_trunc('month', (now() at time zone 'Asia/Shanghai')) - interval '1 month', 'YYYY年FMMM月') as label`,
  );
  if (!bounds) return { built: false };

  const nextDay = new Date(new Date(`${bounds.end}T00:00:00+08:00`).getTime() + 86_400_000)
    .toISOString()
    .slice(0, 10);

  const memories = await fetchMemoriesInRange(bounds.start, nextDay);
  const content = await summarize(`这个月（${bounds.label}）`, memories);
  if (!content) return { built: false, label: bounds.label, memories: memories.length };

  await writePeriod('month', bounds.start, bounds.end, content, new Date().toISOString());
  log.info('月档案已生成', { label: bounds.label, memories: memories.length, chars: content.length });
  return { built: true, label: bounds.label, memories: memories.length };
}

/** 把奠基记忆同步进 foundational_events（她确认过的才进） */
export async function syncFoundationalEvents(): Promise<number> {
  const rows = await many<{ id: string }>(
    `insert into foundational_events (memory_id, title, occurred_at, reason, confirmed, confirmed_at)
     select m.id,
            left(m.content, 40),
            m.event_time,
            '奠基记忆（她确认过，永不衰减、永不压缩）',
            true,
            now()
       from memory_items m
      where m.pinned
        and not exists (select 1 from foundational_events f where f.memory_id = m.id)
     returning id`,
  );
  if (rows.length > 0) log.info('新增奠基事件', { count: rows.length });
  return rows.length;
}

/**
 * 补建漏掉的周/月。
 *
 * 原来只建"上一个"周期：服务停过、任务失败一次，那一段就永远缺了。
 * 现在往回翻，把缺的都补上；连续 3 个空周期就停（更早的本来也没东西）。
 *
 * 每层只压一次，且**都直接从日记忆压**，不是压上一层的摘要 ——
 * 避免"摘要的摘要"一层层失真。
 */
export async function backfillMissing(weeksBack = 10, monthsBack = 6): Promise<{ weeks: number; months: number }> {
  let weeks = 0;
  let months = 0;

  // 周：从上一个自然周往回数
  let empty = 0;
  for (let i = 1; i <= weeksBack; i++) {
    const bounds = await one<{ start: string; end: string; label: string }>(
      `select (date_trunc('week', (now() at time zone 'Asia/Shanghai')) - ($1 || ' weeks')::interval)::date::text as start,
              (date_trunc('week', (now() at time zone 'Asia/Shanghai')) - ($1 || ' weeks')::interval + interval '6 days')::date::text as end,
              to_char(date_trunc('week', (now() at time zone 'Asia/Shanghai')) - ($1 || ' weeks')::interval, 'YYYY-MM-DD')
                || ' ~ ' ||
              to_char(date_trunc('week', (now() at time zone 'Asia/Shanghai')) - ($1 || ' weeks')::interval + interval '6 days', 'YYYY-MM-DD') as label`,
      [String(i)],
    );
    if (!bounds) continue;

    const exists = await one<{ id: string }>(
      `select id::text from timeline_periods where kind = 'week' and period_start = $1::date`,
      [bounds.start],
    );
    if (exists) { empty = 0; continue; }

    const nextDay = new Date(new Date(`${bounds.end}T00:00:00+08:00`).getTime() + 86_400_000).toISOString().slice(0, 10);
    const memories = await fetchMemoriesInRange(bounds.start, nextDay);
    if (memories.length === 0) {
      empty++;
      if (empty >= 3) break;
      continue;
    }
    empty = 0;
    const content = await summarize(`这一周（${bounds.label}）`, memories);
    if (!content) continue;
    await writePeriod('week', bounds.start, bounds.end, content, new Date().toISOString());
    weeks++;
    log.info('补建了周回顾', { label: bounds.label, memories: memories.length });
  }

  // 月：从上一个自然月往回数
  empty = 0;
  for (let i = 1; i <= monthsBack; i++) {
    const bounds = await one<{ start: string; end: string; label: string }>(
      `select (date_trunc('month', (now() at time zone 'Asia/Shanghai')) - ($1 || ' months')::interval)::date::text as start,
              (date_trunc('month', (now() at time zone 'Asia/Shanghai')) - ($1 || ' months')::interval + interval '1 month' - interval '1 day')::date::text as end,
              to_char(date_trunc('month', (now() at time zone 'Asia/Shanghai')) - ($1 || ' months')::interval, 'YYYY年MM月') as label`,
      [String(i)],
    );
    if (!bounds) continue;

    const exists = await one<{ id: string }>(
      `select id::text from timeline_periods where kind = 'month' and period_start = $1::date`,
      [bounds.start],
    );
    if (exists) { empty = 0; continue; }

    const nextDay = new Date(new Date(`${bounds.end}T00:00:00+08:00`).getTime() + 86_400_000).toISOString().slice(0, 10);
    const memories = await fetchMemoriesInRange(bounds.start, nextDay);
    if (memories.length === 0) {
      empty++;
      if (empty >= 3) break;
      continue;
    }
    empty = 0;
    const content = await summarize(`这个月（${bounds.label}）`, memories);
    if (!content) continue;
    await writePeriod('month', bounds.start, bounds.end, content, new Date().toISOString());
    months++;
    log.info('补建了月档案', { label: bounds.label, memories: memories.length });
  }

  return { weeks, months };
}

export async function runTimelineBuild(): Promise<void> {
  try {
    await buildPreviousWeek();
  } catch (err) {
    log.error('周回顾生成失败', errFields(err));
  }
  try {
    await buildPreviousMonth();
  } catch (err) {
    log.error('月档案生成失败', errFields(err));
  }
  try {
    const filled = await backfillMissing();
    if (filled.weeks || filled.months) log.info('补齐了漏掉的周期', filled);
  } catch (err) {
    log.error('补建周期失败', errFields(err));
  }
  try {
    await syncFoundationalEvents();
  } catch (err) {
    log.error('奠基事件同步失败', errFields(err));
  }
}
