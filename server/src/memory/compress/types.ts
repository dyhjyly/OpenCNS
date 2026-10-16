/** 情景记忆压缩器的输入输出类型 */

export type EventTimePrecision = 'exact' | 'day' | 'approx' | 'unknown';

export interface EpisodeQuote {
  who: string;
  said: string;
}

export interface EpisodeCausal {
  happened: string;
  reaction: string;
  act: string;
  outcome: string;
}

export interface EpisodeEmotion {
  valence: number;
  arousal: number;
  dominant?: string;
}

/** 压缩器的产物；字段名与 memory_items 的列一一对应 */
export interface CompressedEpisode {
  scene: string;
  quotes: EpisodeQuote[];
  causal: EpisodeCausal;
  emotion: EpisodeEmotion;
  event_time: string | null;
  event_time_precision: EventTimePrecision;
  importance: number;
  keywords: string[];
}

export interface Violation {
  code: string;
  detail: string;
  /** error 会触发重写；warn 只记账 */
  severity: 'error' | 'warn';
}

/** 与数据库 CHECK 约束保持一致的字数底线 */
export const MIN_SCENE_CHARS = 80;

export const CAUSAL_RINGS = ['happened', 'reaction', 'act', 'outcome'] as const;
