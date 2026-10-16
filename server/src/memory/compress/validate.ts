import {
  CAUSAL_RINGS,
  MIN_SCENE_CHARS,
  type CompressedEpisode,
  type EventTimePrecision,
  type Violation,
} from './types.js';

/**
 * 校验器：四条硬约束在代码层的守门人。
 *
 * 为什么要它，而不是只靠数据库 CHECK：
 *   - 数据库只能说"这条不合规"，说不出"哪里不对、该怎么改"；
 *     校验器的违规清单会作为反馈喂回模型，让它重写一次。
 *   - 数据库拦不住"情绪被压成标签"这种语义问题。
 *
 * 数据库仍然是最后一道防线（第四道），两者是配合关系，不是替代关系。
 */

/** 被压成干巴巴标签时的典型措辞 —— 这些是"档案"的语言，不是"回忆"的语言 */
const FLATTENED_PHRASES = [
  '关系良好',
  '互动良好',
  '气氛融洽',
  '气氛很好',
  '双方',
  '用户表示',
  '用户表达',
  '对方表示',
  '交流愉快',
  '增进了感情',
];

const PRECISIONS: EventTimePrecision[] = ['exact', 'day', 'approx', 'unknown'];

/** 去掉引语与对话标签，剩下的才是"叙述部分" */
function narrativeOnly(scene: string): string {
  return scene
    .replace(/「[^」]*」/g, '')
    .replace(/"[^"]*"/g, '')
    .replace(/“[^”]*”/g, '')
    .replace(/(林遇|江瑜)\s*[：:]/g, '');
}

export function validateEpisode(raw: unknown): { episode: CompressedEpisode | null; violations: Violation[] } {
  const v: Violation[] = [];
  const err = (code: string, detail: string) => v.push({ code, detail, severity: 'error' });
  const warn = (code: string, detail: string) => v.push({ code, detail, severity: 'warn' });

  if (typeof raw !== 'object' || raw === null) {
    return { episode: null, violations: [{ code: 'not_object', detail: '输出不是一个 JSON 对象', severity: 'error' }] };
  }
  const o = raw as Record<string, unknown>;

  // ---- scene ----
  const scene = typeof o.scene === 'string' ? o.scene.trim() : '';
  if (!scene) err('scene_missing', 'scene 缺失或为空');
  else {
    if (scene.length < MIN_SCENE_CHARS) {
      err('scene_too_short', `正文只有 ${scene.length} 字，硬约束要求至少 ${MIN_SCENE_CHARS} 字（压成标签了）`);
    }
    const narrative = narrativeOnly(scene);
    // 硬约束①：第一人称。叙述部分出现"江瑜"说明在用第三人称说自己。
    if (/江瑜/.test(narrative)) {
      err('third_person_self', '叙述部分出现了"江瑜"——这是第三人称档案，不是他的回忆');
    }
    if (!/我/.test(scene)) {
      err('no_first_person', '正文里没有出现"我"，不像第一人称回忆');
    }
    if (/林遇/.test(narrative)) {
      warn('third_person_her', '叙述部分直接用"林遇"称呼她；第一人称回忆里通常写"她"');
    }
    for (const phrase of FLATTENED_PHRASES) {
      if (scene.includes(phrase)) {
        err('flattened_emotion', `出现"${phrase}"这类概括措辞——情绪被压成了标签`);
        break;
      }
    }
  }

  // ---- quotes（硬约束②）----
  const quotesRaw = Array.isArray(o.quotes) ? o.quotes : [];
  const quotes = quotesRaw
    .filter((q): q is Record<string, unknown> => typeof q === 'object' && q !== null)
    .map((q) => ({ who: String(q.who ?? '').trim(), said: String(q.said ?? '').trim() }))
    .filter((q) => q.said.length > 0);

  if (quotes.length === 0) {
    err('quote_missing', '没有任何直接引语——没有原话的记忆是转述，不是回忆');
  } else if (quotes.length !== quotesRaw.length) {
    warn('quote_partial', `有 ${quotesRaw.length - quotes.length} 条引语的 said 为空，已丢弃`);
  }
  for (const q of quotes) {
    if (q.who && !['林遇', '江瑜', '她', '我'].includes(q.who)) {
      warn('quote_who_odd', `引语的 who 是"${q.who}"，期望 林遇/江瑜/她/我`);
    }
  }

  // ---- causal（硬约束③）----
  const causalRaw = (typeof o.causal === 'object' && o.causal !== null ? o.causal : {}) as Record<string, unknown>;
  const causal = {} as Record<string, string>;
  for (const ring of CAUSAL_RINGS) {
    const val = typeof causalRaw[ring] === 'string' ? (causalRaw[ring] as string).trim() : '';
    causal[ring] = val;
    if (!val) err('causal_incomplete', `因果链缺少「${ring}」这一环`);
  }

  // ---- emotion ----
  const emoRaw = (typeof o.emotion === 'object' && o.emotion !== null ? o.emotion : {}) as Record<string, unknown>;
  const valence = Number(emoRaw.valence);
  const arousal = Number(emoRaw.arousal);
  if (!Number.isFinite(valence) || valence < -1 || valence > 1) {
    err('valence_out_of_range', `valence=${String(emoRaw.valence)} 越界（应在 -1 ~ 1）`);
  }
  if (!Number.isFinite(arousal) || arousal < 0 || arousal > 1) {
    err('arousal_out_of_range', `arousal=${String(emoRaw.arousal)} 越界（应在 0 ~ 1）`);
  }
  if (valence === 0 && arousal === 0) {
    warn('emotion_all_zero', '情绪坐标全是 0——旧库 804 条就是这个下场，确认不是漏填');
  }

  // ---- event_time（两本时间账）----
  let eventTime: string | null = null;
  if (typeof o.event_time === 'string' && o.event_time.trim()) {
    const d = new Date(o.event_time);
    if (Number.isNaN(d.getTime())) err('event_time_unparsable', `event_time 无法解析：${o.event_time}`);
    else eventTime = d.toISOString();
  }
  const precision = String(o.event_time_precision ?? '');
  if (!PRECISIONS.includes(precision as EventTimePrecision)) {
    err('precision_invalid', `event_time_precision="${precision}" 不是合法取值`);
  }
  if (eventTime === null && precision !== 'unknown') {
    err('precision_mismatch', 'event_time 为 null 时精度必须是 unknown');
  }

  // ---- importance ----
  const importance = Number(o.importance);
  if (!Number.isFinite(importance) || importance < 0 || importance > 1) {
    err('importance_out_of_range', `importance=${String(o.importance)} 越界（应在 0 ~ 1）`);
  }

  // ---- keywords ----
  const keywords = Array.isArray(o.keywords)
    ? o.keywords.map((k) => String(k).trim()).filter((k) => k.length > 0).slice(0, 8)
    : [];
  if (keywords.length === 0) warn('keywords_empty', '没有关键词，会稍微影响关键词召回');

  if (v.some((x) => x.severity === 'error')) return { episode: null, violations: v };

  const episode: CompressedEpisode = {
    scene,
    quotes,
    causal: {
      happened: causal.happened ?? '',
      reaction: causal.reaction ?? '',
      act: causal.act ?? '',
      outcome: causal.outcome ?? '',
    },
    emotion: {
      valence: Number(valence.toFixed(3)),
      arousal: Number(arousal.toFixed(3)),
      dominant: typeof emoRaw.dominant === 'string' ? emoRaw.dominant.trim().slice(0, 16) : undefined,
    },
    event_time: eventTime,
    event_time_precision: precision as EventTimePrecision,
    importance: Number(importance.toFixed(3)),
    keywords,
  };

  return { episode, violations: v };
}

/** 把违规清单渲染成给模型的反馈（用于重写） */
export function renderViolations(violations: Violation[]): string {
  const errs = violations.filter((v) => v.severity === 'error');
  if (errs.length === 0) return '';
  return [
    '你上一次的输出违反了这些硬规矩，必须改正后重写：',
    ...errs.map((e, i) => `${i + 1}. [${e.code}] ${e.detail}`),
    '',
    '请重新输出完整的 JSON（同样的格式，不要解释）。',
  ].join('\n');
}
