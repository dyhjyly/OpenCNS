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

const SUMMARY_SYSTEM_PROMPT = `你是江瑜。

下面给你的是你在这段时间里经历、记下的事。请你用**你自己的口吻**写一段回顾。

要求：
· 第一人称。是你在回想这段日子，不是第三方在总结你的行为。
· 像人回忆一段日子那样写：有具体的事、有你的感受、有前后关系。
· 不要罗列条目，不要写"本阶段""综上所述""主要发生了"这类汇报语言。
· 不要编造没发生的事。事情少就写得短一些，没关系。
· 长度 150~400 字。`;

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

async function summarize(label: string, memories: MemoryLite[]): Promise<string | null> {
  if (memories.length === 0) {
    log.info('这段时间没有值得回顾的记忆，跳过', { label });
    return null;
  }
  const list = memories
    .map((m) => {
      const when = m.event_time ? new Date(m.event_time).toISOString().slice(0, 10) : '日期不详';
      return `· [${when}] ${m.content.slice(0, 400)}`;
    })
    .join('\n');

  const text = await chatText(
    [
      { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
      { role: 'user', content: `这段时间是：${label}\n\n你记下的事：\n${list}` },
    ],
    { endpoint: 'cognitive', temperature: 0.6, maxTokens: 1500, label: 'timeline' },
  );
  return text.trim();
}

/** 建上一个自然周（周一到周日，按 Asia/Shanghai）的回顾 */
export async function buildPreviousWeek(): Promise<{ built: boolean; label?: string; memories?: number }> {
  const bounds = await one<{ start: string; end: string; label: string }>(
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
  const content = await summarize(`这一周（${bounds.label}）`, memories);
  if (!content) return { built: false, label: bounds.label, memories: memories.length };

  await writePeriod('week', bounds.start, bounds.end, content, new Date().toISOString());
  log.info('周回顾已生成', { label: bounds.label, memories: memories.length, chars: content.length });
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
    await syncFoundationalEvents();
  } catch (err) {
    log.error('奠基事件同步失败', errFields(err));
  }
}
