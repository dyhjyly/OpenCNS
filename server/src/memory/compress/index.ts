import { many, one, query } from '../../db/pool.js';
import { chatJson, type ChatMessage } from '../../llm/client.js';
import { log, errFields } from '../../logger.js';
import { buildCompressorMessages, renderConversationSlice, type CompressorExample } from './prompt.js';
import { renderViolations, validateEpisode } from './validate.js';
import type { CompressedEpisode, Violation } from './types.js';

/**
 * 情景记忆压缩管道 —— 系统的"记忆形成"这一步。
 *
 * 一段已经过去的对话，进来；一条第一人称回忆，出去。
 *
 * 流程刻意做成四道闸门：
 *   1) 提示词里的四条硬约束（模型自己守）
 *   2) 校验器（代码守，并把违规清单喂回去让它重写一次）
 *   3) 压缩失败样本表（两次都不合规就留案，绝不静默丢数据）
 *   4) 数据库 CHECK 约束（最后防线，连写入器写错了也拦得住）
 */

export interface SliceMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  eventTime: Date | string;
}

export interface CompressMeta {
  sessionId?: string | null;
  fromSeq?: number | null;
  toSeq?: number | null;
}

export interface CompressOutcome {
  ok: boolean;
  episodeId?: string;
  episode?: CompressedEpisode;
  violations: Violation[];
  attempts: number;
  reason?: string;
}

interface GoldenRow {
  content: string;
  quotes: { who?: string; said?: string }[];
  causal: Record<string, string> | null;
  emotion_valence: number | null;
  emotion_arousal: number | null;
  emotion_dominant: string | null;
  event_time: string | null;
  event_time_precision: string;
  importance: number;
  keywords: string[];
}

/**
 * 风格锚点从库里取 —— 用"已经确认的好记忆"教它怎么写记忆，
 * 而不是把真实私人内容硬编码进公开仓库的提示词文件里。
 * 输入侧由引语还原（引语本来就是那段对话的骨架）。
 */
export async function loadGoldenExamples(limit = 2): Promise<CompressorExample[]> {
  const rows = await many<GoldenRow>(
    `select content, quotes, causal, emotion_valence, emotion_arousal, emotion_dominant,
            event_time, event_time_precision, importance, keywords
       from memory_items
      where kind = 'episode' and state = 'active'
      order by importance desc, created_at asc
      limit $1`,
    [limit],
  );

  return rows.map((r) => {
    const lines = (r.quotes ?? [])
      .filter((q) => q.said)
      .map((q) => `[${r.event_time ? new Date(r.event_time).toISOString().slice(0, 16).replace('T', ' ') : '时间不详'}] ${q.who === '江瑜' ? '我' : '她'}：${q.said}`);
    return {
      input: lines.length > 0 ? lines.join('\n') : '(原始对话未留存，仅作风格参考)',
      output: {
        scene: r.content,
        quotes: r.quotes,
        causal: r.causal ?? {},
        emotion: {
          valence: r.emotion_valence,
          arousal: r.emotion_arousal,
          dominant: r.emotion_dominant,
        },
        event_time: r.event_time,
        event_time_precision: r.event_time_precision,
        importance: r.importance,
        keywords: r.keywords,
      },
    };
  });
}

/** 两次都不合规时留案，供人工观察提示词该怎么改 */
async function recordFailure(
  meta: CompressMeta,
  draft: string,
  violations: Violation[],
): Promise<void> {
  await query(
    `insert into compression_failures (session_id, source_from_seq, source_to_seq, draft, violations)
     values ($1, $2, $3, $4, $5::jsonb)`,
    [meta.sessionId ?? null, meta.fromSeq ?? null, meta.toSeq ?? null, draft.slice(0, 8000), JSON.stringify(violations)],
  );
  log.warn('压缩失败样本已留案', {
    codes: violations.filter((v) => v.severity === 'error').map((v) => v.code),
  });
}

async function insertEpisode(
  ep: CompressedEpisode,
  meta: CompressMeta,
): Promise<string> {
  const row = await one<{ id: string }>(
    `insert into memory_items (
        kind, origin, subject, content, quotes, causal,
        emotion_valence, emotion_arousal, emotion_dominant,
        event_time, event_time_precision, ingested_at,
        session_id, source_from_seq, source_to_seq,
        privacy, state, importance, decay_score, keywords, provenance
     ) values (
        'episode', 'auto', 'shared', $1, $2::jsonb, $3::jsonb,
        $4, $5, $6,
        $7, $8, now(),
        $9, $10, $11,
        'private', 'active', $12, 1.0, $13::text[], $14::jsonb
     ) returning id`,
    [
      ep.scene,
      JSON.stringify(ep.quotes),
      JSON.stringify(ep.causal),
      ep.emotion.valence,
      ep.emotion.arousal,
      ep.emotion.dominant ?? null,
      ep.event_time,
      ep.event_time_precision,
      meta.sessionId ?? null,
      meta.fromSeq ?? null,
      meta.toSeq ?? null,
      ep.importance,
      ep.keywords,
      JSON.stringify({ source: 'compressor', compressed_at: new Date().toISOString() }),
    ],
  );
  if (!row) throw new Error('插入 episode 后没有返回 id');
  return row.id;
}

export async function compressSlice(slice: SliceMessage[], meta: CompressMeta = {}): Promise<CompressOutcome> {
  const real = slice.filter((m) => m.role !== 'system' && m.content.trim().length > 0);
  if (real.length === 0) {
    return { ok: false, violations: [], attempts: 0, reason: 'empty-slice' };
  }

  const conversation = renderConversationSlice(real);
  let examples: CompressorExample[] = [];
  try {
    examples = await loadGoldenExamples();
  } catch (err) {
    log.warn('取风格锚点失败，退回合成示例', errFields(err));
  }

  const base: ChatMessage[] = buildCompressorMessages({ conversation, examples });
  let violations: Violation[] = [];
  let lastDraft = '';

  for (let attempt = 1; attempt <= 2; attempt++) {
    const messages: ChatMessage[] =
      attempt === 1
        ? base
        : [...base, { role: 'assistant', content: lastDraft }, { role: 'user', content: renderViolations(violations) }];

    let raw: unknown;
    try {
      raw = await chatJson<unknown>(messages, {
        endpoint: 'cognitive',
        temperature: 0.4,
        maxTokens: 1600,
        label: 'compress',
      });
      lastDraft = JSON.stringify(raw);
    } catch (err) {
      log.error('压缩调用失败', { attempt, ...errFields(err) });
      if (attempt === 2) return { ok: false, violations, attempts: attempt, reason: 'llm-error' };
      continue;
    }

    const result = validateEpisode(raw);
    violations = result.violations;

    if (!result.episode) {
      log.warn('压缩结果不合规', {
        attempt,
        errors: violations.filter((v) => v.severity === 'error').map((v) => `${v.code}: ${v.detail}`),
      });
      continue;
    }

    // 事件时间兜底：模型没给就用这段对话的第一个时间戳（精度降到 day）
    const episode = result.episode;
    if (episode.event_time === null) {
      const first = real[0];
      if (first) {
        episode.event_time = new Date(first.eventTime).toISOString();
        episode.event_time_precision = 'day';
        violations.push({
          code: 'event_time_fallback',
          detail: '模型未给出事件时间，已用对话首个时间戳兜底并降级为 day',
          severity: 'warn',
        });
      }
    }

    try {
      const id = await insertEpisode(episode, meta);
      log.info('新情景记忆入库', {
        id,
        chars: episode.scene.length,
        quotes: episode.quotes.length,
        valence: episode.emotion.valence,
        arousal: episode.emotion.arousal,
        importance: episode.importance,
        attempt,
      });
      return { ok: true, episodeId: id, episode, violations, attempts: attempt };
    } catch (err) {
      // 23514 = check_violation：校验器漏掉的，数据库兜住了
      const code = (err as { code?: string }).code;
      log.error('写入 episode 被数据库拒绝', { pgCode: code, ...errFields(err) });
      await recordFailure(meta, lastDraft, [
        ...violations,
        { code: `db_${code ?? 'error'}`, detail: String((err as Error).message).slice(0, 300), severity: 'error' },
      ]);
      return { ok: false, violations, attempts: attempt, reason: `db-${code ?? 'error'}` };
    }
  }

  await recordFailure(meta, lastDraft, violations);
  return { ok: false, violations, attempts: 2, reason: 'still-invalid' };
}
