import { many, one, query } from '../db/pool.js';
import { chatJson } from '../llm/client.js';
import { log, errFields } from '../logger.js';
import { readUpload } from '../chat/uploads.js';
import type { ChatMessage, ContentPart } from '../llm/client.js';

/**
 * 睡眠记录。
 *
 * 手环截图 → 模型读图 → 结构化落库。识别不准允许手动改。
 * 这里不做"猜"：读不出来的字段一律 null，宁可缺也不要编。
 */

export interface SleepRecord {
  night: string;
  bedtime: string | null;
  wakeTime: string | null;
  totalMinutes: number | null;
  awakeCount: number | null;
  deepMinutes: number | null;
  lightMinutes: number | null;
  remMinutes: number | null;
  awakeMinutes: number | null;
  confidence: number | null;
  source: string;
  note: string | null;
}

const PROMPT = `你是一个数据提取器。看这张小米手环的睡眠截图，把里面的数字读出来。

只输出 JSON，不要解释：
{
  "night": "YYYY-MM-DD（醒来的那天；图上只有月日就按今年补全）",
  "bedtime": "HH:MM",
  "wakeTime": "HH:MM",
  "totalMinutes": 睡眠总时长（分钟，整数）,
  "awakeCount": 清醒次数,
  "deepMinutes": 深睡分钟数,
  "lightMinutes": 浅睡分钟数,
  "remMinutes": 快速眼动分钟数,
  "awakeMinutes": 清醒分钟数,
  "confidence": 0.0~1.0 之间，你对这次读取的把握
}

规则：
· 图上没有的字段一律给 null，**绝对不要估算或补全**。
· 时长如果图上是"7小时31分"，换成 451 分钟。
· night 读不出来就给 null。`;

interface RawSleep {
  night?: unknown;
  bedtime?: unknown;
  wakeTime?: unknown;
  totalMinutes?: unknown;
  awakeCount?: unknown;
  deepMinutes?: unknown;
  lightMinutes?: unknown;
  remMinutes?: unknown;
  awakeMinutes?: unknown;
  confidence?: unknown;
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/[^\d.-]/g, '')) : NaN;
  return Number.isFinite(n) ? Math.round(n) : null;
};
const str = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s && s !== 'null' ? s : null;
};

/** "7小时31分" / "7h31m" / 451 都换成分钟 */
function toMinutes(v: unknown): number | null {
  if (typeof v === 'number') return Math.round(v);
  const s = String(v ?? '');
  if (!s.trim()) return null;
  const hm = /(\d+)\s*[小时h:]\s*(\d+)?/.exec(s);
  if (hm) {
    const h = Number(hm[1]);
    const m = hm[2] ? Number(hm[2]) : 0;
    return h * 60 + m;
  }
  const plain = Number(s.replace(/[^\d.]/g, ''));
  return Number.isFinite(plain) ? Math.round(plain) : null;
}

export async function analyzeScreenshot(uploadId: string): Promise<{
  record: SleepRecord | null;
  raw: RawSleep | null;
  error?: string;
}> {
  const file = await readUpload(uploadId).catch(() => null);
  if (!file) return { record: null, raw: null, error: '找不到这张图' };

  const imagePart: ContentPart = {
    type: 'image_url',
    image_url: { url: `data:image/${file.ext.replace('.', '')};base64,${file.buf.toString('base64')}` },
  };

  const messages: ChatMessage[] = [
    { role: 'user', content: [{ type: 'text', text: PROMPT }, imagePart] },
  ];

  let raw: RawSleep;
  try {
    raw = await chatJson<RawSleep>(messages, {
      endpoint: 'cognitive', // flash 支持看图；pro 不支持
      temperature: 0.1,
      maxTokens: 2000,
      label: 'sleep-ocr',
    });
  } catch (err) {
    log.error('睡眠截图识别失败', errFields(err));
    return { record: null, raw: null, error: String((err as Error)?.message ?? err).slice(0, 200) };
  }

  const night = str(raw.night);
  if (!night || !/^\d{4}-\d{2}-\d{2}$/.test(night)) {
    return { record: null, raw, error: '没读出来是哪一晚' };
  }

  const record: SleepRecord = {
    night,
    bedtime: str(raw.bedtime),
    wakeTime: str(raw.wakeTime),
    totalMinutes: toMinutes(raw.totalMinutes),
    awakeCount: num(raw.awakeCount),
    deepMinutes: toMinutes(raw.deepMinutes),
    lightMinutes: toMinutes(raw.lightMinutes),
    remMinutes: toMinutes(raw.remMinutes),
    awakeMinutes: toMinutes(raw.awakeMinutes),
    confidence: num(raw.confidence) !== null ? Math.min(1, Math.max(0, Number(raw.confidence))) : null,
    source: 'screenshot',
    note: null,
  };

  await query(
    `insert into sleep_records
       (night, bedtime, wake_time, total_minutes, awake_count,
        deep_minutes, light_minutes, rem_minutes, awake_minutes,
        confidence, source, upload_id, raw)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'screenshot',$11,$12::jsonb)
     on conflict (night) do update set
       bedtime = excluded.bedtime, wake_time = excluded.wake_time,
       total_minutes = excluded.total_minutes, awake_count = excluded.awake_count,
       deep_minutes = excluded.deep_minutes, light_minutes = excluded.light_minutes,
       rem_minutes = excluded.rem_minutes, awake_minutes = excluded.awake_minutes,
       confidence = excluded.confidence, upload_id = excluded.upload_id,
       raw = excluded.raw, updated_at = now()`,
    [
      record.night,
      record.bedtime,
      record.wakeTime,
      record.totalMinutes,
      record.awakeCount,
      record.deepMinutes,
      record.lightMinutes,
      record.remMinutes,
      record.awakeMinutes,
      record.confidence,
      uploadId,
      JSON.stringify(raw),
    ],
  );

  log.info('睡眠记录已存', { night, total: record.totalMinutes, deep: record.deepMinutes, conf: record.confidence });
  return { record, raw };
}

/** 手动修正某一天 */
export async function patchSleep(night: string, patch: Partial<SleepRecord>): Promise<boolean> {
  const row = await one<{ id: string }>(`select id from sleep_records where night = $1`, [night]);
  if (!row) return false;
  await query(
    `update sleep_records set
       bedtime = coalesce($2, bedtime),
       wake_time = coalesce($3, wake_time),
       total_minutes = coalesce($4, total_minutes),
       awake_count = coalesce($5, awake_count),
       deep_minutes = coalesce($6, deep_minutes),
       light_minutes = coalesce($7, light_minutes),
       rem_minutes = coalesce($8, rem_minutes),
       awake_minutes = coalesce($9, awake_minutes),
       note = coalesce($10, note),
       source = 'manual', updated_at = now()
     where night = $1`,
    [
      night,
      patch.bedtime ?? null,
      patch.wakeTime ?? null,
      patch.totalMinutes ?? null,
      patch.awakeCount ?? null,
      patch.deepMinutes ?? null,
      patch.lightMinutes ?? null,
      patch.remMinutes ?? null,
      patch.awakeMinutes ?? null,
      patch.note ?? null,
    ],
  );
  return true;
}

export async function listSleep(days = 30): Promise<SleepRecord[]> {
  const rows = await many<{
    night: string;
    bedtime: string | null;
    wake_time: string | null;
    total_minutes: number | null;
    awake_count: number | null;
    deep_minutes: number | null;
    light_minutes: number | null;
    rem_minutes: number | null;
    awake_minutes: number | null;
    confidence: number | null;
    source: string;
    note: string | null;
  }>(
    `select night::text, bedtime, wake_time, total_minutes, awake_count,
            deep_minutes, light_minutes, rem_minutes, awake_minutes,
            confidence, source, note
       from sleep_records
      where night > current_date - ($1 || ' days')::interval
      order by night desc`,
    [String(days)],
  );
  return rows.map((r) => ({
    night: r.night,
    bedtime: r.bedtime,
    wakeTime: r.wake_time,
    totalMinutes: r.total_minutes,
    awakeCount: r.awake_count,
    deepMinutes: r.deep_minutes,
    lightMinutes: r.light_minutes,
    remMinutes: r.rem_minutes,
    awakeMinutes: r.awake_minutes,
    confidence: r.confidence === null ? null : Number(r.confidence),
    source: r.source,
    note: r.note,
  }));
}

export interface SleepStats {
  count: number;
  avgTotalMinutes: number | null;
  avgDeepPct: number | null;
  worstDeepPct: number | null;
  avgBedtime: string | null;
  trend: { night: string; totalMinutes: number | null; deepPct: number | null }[];
}

export async function sleepStats(days = 30): Promise<SleepStats> {
  const rows = await listSleep(days);
  const withTotal = rows.filter((r) => r.totalMinutes && r.totalMinutes > 0);
  const deepPctOf = (r: SleepRecord) =>
    r.deepMinutes !== null && r.totalMinutes ? Math.round((r.deepMinutes / r.totalMinutes) * 1000) / 10 : null;

  const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
  const totals = withTotal.map((r) => r.totalMinutes!).filter(Boolean);
  const deeps = rows.map(deepPctOf).filter((x): x is number => x !== null);
  const bedtimes = rows.map((r) => r.bedtime).filter((x): x is string => Boolean(x));

  // 入睡时间平均：都换算成"凌晨分钟数"（22:00 => 22*60，01:30 => 25*60）再平均
  let avgBedtime: string | null = null;
  if (bedtimes.length) {
    const mins = bedtimes.map((t) => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(t);
      if (!m) return null;
      const h = Number(m[1]);
      return (h < 12 ? h + 24 : h) * 60 + Number(m[2]);
    }).filter((x): x is number => x !== null);
    if (mins.length) {
      const a = Math.round(mins.reduce((x, y) => x + y, 0) / mins.length) % 1440;
      avgBedtime = `${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
    }
  }

  return {
    count: rows.length,
    avgTotalMinutes: avg(totals),
    avgDeepPct: avg(deeps),
    worstDeepPct: deeps.length ? Math.min(...deeps) : null,
    avgBedtime,
    trend: rows
      .slice()
      .reverse()
      .map((r) => ({ night: r.night, totalMinutes: r.totalMinutes, deepPct: deepPctOf(r) })),
  };
}
