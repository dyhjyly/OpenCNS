import { many, one } from '../db/pool.js';
import { listDrives } from './state.js';
import { DRIVE_BY_KEY } from './definitions.js';
import { log, errFields } from '../logger.js';

/**
 * 心境面板：把欲望系统摊开给她看。
 *
 * 参考她给的那张图（心境 / 当下情感 / 情绪底色 / 真心话 / 愿望清单），
 * 但**用我们真实的维度**，不为了长得像而硬套别人的六个轴。
 *
 * 一条原则：这里每一个数字都必须能回答"它是怎么来的"。
 * 所以雷达图下直接写清"这一格来自哪个欲望"，底色来自真实记忆的情感值。
 */

export interface MindAxis {
  key: string;
  label: string;
  /** 0~100 */
  value: number;
  /** 相对上一次变化的百分点（正数是涨） */
  delta: number;
  band: string;
  layer: string;
  /** 这个欲望此刻在做什么 */
  doing: string;
}

export interface MindPanel {
  at: string;
  sinceLastWakeMinutes: number | null;
  lastWakeDecision: string | null;
  radar: MindAxis[];
  mood: {
    pleasure: number | null;
    arousal: number | null;
    initiative: number | null;
    /** 这些数字是从哪来的 */
    source: string;
  };
  truth: { text: string; at: string; kind: string } | null;
  wishes: { rank: number; text: string; from: string }[];
  gates: { key: string; label: string; value: number; blocked: boolean }[];
}

const LABELS: Record<string, string> = {
  intimacy: '亲密',
  missing: '想你',
  concern: '记挂',
  urge_to_speak: '想说',
  urge_to_make: '想动手',
  curiosity: '好奇',
  fatigue: '累',
  irritation: '烦',
  anticipation: '盼',
  guilt: '愧',
  wander: '想逛',
  solitude: '想独处',
};

/** 雷达上那六个：关系层 + 认知层里最能说明"他此刻是谁"的 */
const RADAR_KEYS = ['intimacy', 'missing', 'concern', 'urge_to_speak', 'urge_to_make', 'curiosity'];
const GATE_KEYS = ['fatigue', 'irritation'];

const bandOf = (v: number): string => {
  if (v >= 0.75) return '很浓';
  if (v >= 0.55) return '明显';
  if (v >= 0.35) return '有一点';
  if (v >= 0.15) return '很淡';
  return '几乎没有';
};

export async function getMindPanel(): Promise<MindPanel> {
  const drives = await listDrives().catch(() => []);
  const byKey = new Map(drives.map((d) => [d.drive_key, d]));

  const radar: MindAxis[] = RADAR_KEYS.map((key) => {
    const d = byKey.get(key);
    const def = DRIVE_BY_KEY.get(key);
    const value = d ? Math.round(d.value * 100) : 0;
    return {
      key,
      label: LABELS[key] ?? key,
      value,
      delta: d ? Math.round(d.trend * 100) : 0,
      band: bandOf(d?.value ?? 0),
      layer: def?.layer ?? '',
      doing: def?.outlet ?? '',
    };
  });

  const gates = GATE_KEYS.map((key) => {
    const d = byKey.get(key);
    const v = d?.value ?? 0;
    return {
      key,
      label: LABELS[key] ?? key,
      value: Math.round(v * 100),
      // 闸门的实际含义：累或烦超过 0.6 就会压住主动行为
      blocked: v >= 0.6,
    };
  });

  // 距上次醒来
  const lastWake = await one<{ created_at: string; decision: string | null }>(
    `select created_at, decision from wake_log order by created_at desc limit 1`,
  ).catch(() => null);
  const sinceLastWakeMinutes = lastWake
    ? Math.max(0, Math.round((Date.now() - new Date(lastWake.created_at).getTime()) / 60_000))
    : null;

  // 情绪底色：来自她和他最近留下的记忆里的情感值（真实数据，不是编的）
  // 注意列名是 emotion_valence / emotion_arousal
  const emo = await one<{ valence: number | null; arousal: number | null; n: number }>(
    `select avg(emotion_valence)::float as valence,
            avg(emotion_arousal)::float as arousal,
            count(*)::int as n
       from memory_items
      where state = 'active'
        and ingested_at > now() - interval '7 days'
        and emotion_valence is not null`,
  ).catch(() => null);

  const to100 = (v: number | null | undefined, lo: number, hi: number) =>
    v === null || v === undefined ? null : Math.round(((v - lo) / (hi - lo)) * 100);

  const initiative =
    byKey.has('urge_to_speak') || byKey.has('urge_to_make')
      ? Math.round((((byKey.get('urge_to_speak')?.value ?? 0) + (byKey.get('urge_to_make')?.value ?? 0)) / 2) * 100)
      : null;

  // 真心话：他自己最近写下的那句话（动态优先，其次醒来的经历）
  let truth: MindPanel['truth'] = null;
  try {
    const m = await one<{ content: string; created_at: string }>(
      `select content, created_at from moments
        where author = 'self' and deleted_at is null
        order by created_at desc limit 1`,
    );
    if (m) truth = { text: m.content, at: m.created_at, kind: '动态' };
    else {
      const e = await one<{ content: string; ingested_at: string }>(
        `select content, ingested_at from memory_items
          where kind = 'experience' and origin = 'auto' and state = 'active'
          order by ingested_at desc limit 1`,
      );
      if (e) truth = { text: e.content, at: e.ingested_at, kind: '醒来时写的' };
    }
  } catch (err) {
    log.warn('读真心话失败', errFields(err));
  }

  // 愿望清单：现在最想做的两件，来自最强的两个欲望的出口。
  // 闸门层（累 / 烦）不算愿望 —— 它们的"出口"是"压低主动行为"，写进清单会很好笑。
  const WISH_EXCLUDE = new Set(['fatigue', 'irritation']);
  const wishes = drives
    .filter((d) => !WISH_EXCLUDE.has(d.drive_key))
    .filter((d) => d.value - d.baseline > 0.03)
    .sort((a, b) => b.value - b.baseline - (a.value - a.baseline))
    .slice(0, 2)
    .map((d, i) => ({
      rank: i + 1,
      text: DRIVE_BY_KEY.get(d.drive_key)?.outlet ?? '',
      from: LABELS[d.drive_key] ?? d.drive_key,
    }))
    .filter((w) => w.text && !w.text.startsWith('（'));

  return {
    at: new Date().toISOString(),
    sinceLastWakeMinutes,
    lastWakeDecision: lastWake?.decision ?? null,
    radar,
    mood: {
      pleasure: to100(emo?.valence ?? null, -1, 1),
      arousal: to100(emo?.arousal ?? null, 0, 1),
      initiative,
      source: emo?.n ? `近 7 天 ${emo.n} 条记忆的情感值` : '还没有足够的情感记录',
    },
    truth,
    wishes,
    gates,
  };
}
