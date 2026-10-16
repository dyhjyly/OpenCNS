import type { SliceMessage } from './index.js';

/**
 * 切段器：决定一段对话从哪里断开。
 *
 * 为什么不能"整段会话一次性压缩"：
 *   - 一次会话可能有几百条消息，压成一条记忆会把细节糊掉；
 *   - 构想要的是"按自然停顿切段"，一段一件完整的事。
 *
 * 主信号是**时间间隔**（人说话本来就是自然停顿的），
 * 辅以条数与字数上限，防止长时间连续输出被压成一大团。
 */

export interface SegmentOptions {
  /** 超过这个间隔就断开（默认 20 分钟） */
  gapMs?: number;
  /** 一段最多几条消息（默认 30） */
  maxMessages?: number;
  /** 一段最多多少字（默认 2000） */
  maxChars?: number;
  /** 少于这个条数的碎段并入相邻段，不单独成段（默认 2） */
  minMessages?: number;
}

const DEFAULTS: Required<SegmentOptions> = {
  gapMs: 20 * 60 * 1000,
  maxMessages: 30,
  maxChars: 2000,
  minMessages: 2,
};

function tsOf(m: SliceMessage): number {
  return new Date(m.eventTime).getTime();
}

export function segmentMessages(messages: SliceMessage[], opts: SegmentOptions = {}): SliceMessage[][] {
  const o = { ...DEFAULTS, ...opts };
  const real = messages.filter((m) => m.role !== 'system' && m.content.trim().length > 0);
  if (real.length === 0) return [];

  const segments: SliceMessage[][] = [];
  let current: SliceMessage[] = [];
  let currentChars = 0;

  for (const m of real) {
    const prev = current[current.length - 1];
    const gapTooBig = prev !== undefined && tsOf(m) - tsOf(prev) > o.gapMs;
    const tooMany = current.length >= o.maxMessages;
    const tooLong = currentChars + m.content.length > o.maxChars;

    if (current.length > 0 && (gapTooBig || tooMany || tooLong)) {
      segments.push(current);
      current = [];
      currentChars = 0;
    }

    current.push(m);
    currentChars += m.content.length;
  }
  if (current.length > 0) segments.push(current);

  // 碎段合并：太短的一段并进前一段（第一段则并进后一段）
  const merged: SliceMessage[][] = [];
  for (const seg of segments) {
    if (seg.length < o.minMessages && merged.length > 0) {
      merged[merged.length - 1] = [...merged[merged.length - 1]!, ...seg];
    } else {
      merged.push(seg);
    }
  }
  if (merged.length > 1 && merged[0]!.length < o.minMessages) {
    merged[1] = [...merged[0]!, ...merged[1]!];
    merged.shift();
  }

  return merged;
}

/** 供日志与调试：一句话描述切段结果 */
export function describeSegments(segments: SliceMessage[][]): string {
  return segments
    .map((s, i) => {
      const chars = s.reduce((n, m) => n + m.content.length, 0);
      const from = new Date(s[0]!.eventTime).toISOString().slice(11, 16);
      const to = new Date(s[s.length - 1]!.eventTime).toISOString().slice(11, 16);
      return `#${i + 1}(${s.length}条/${chars}字 ${from}~${to})`;
    })
    .join(' ');
}
