import { many, query } from '../db/pool.js';
import { log, errFields } from '../logger.js';

/**
 * 模型用量记账。
 *
 * 落库是为了回答三个问题：今天花了多少、花在哪个环节、缓存命中省了多少。
 * 记账失败绝不能影响对话本身 —— 所以这里全是 fire-and-forget。
 */

export interface UsageInput {
  endpoint: string;
  model: string;
  label?: string;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  estimated?: boolean;
  ms?: number;
}

export function recordUsage(input: UsageInput): void {
  void query(
    `insert into llm_usage
       (endpoint, model, label, prompt_tokens, completion_tokens, cached_tokens, reasoning_tokens, estimated, ms)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      input.endpoint,
      input.model,
      input.label ?? null,
      input.promptTokens ?? 0,
      input.completionTokens ?? 0,
      input.cachedTokens ?? 0,
      input.reasoningTokens ?? 0,
      input.estimated ?? false,
      input.ms ?? null,
    ],
  ).catch((err) => log.warn('用量记账失败', errFields(err)));
}

/** 流式没有精确 usage，用字数估一个（中文接近 1 token/字，英文约 4 字符/token） */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/.test(ch)) cjk++;
    else other++;
  }
  return Math.round(cjk * 0.95 + other / 4);
}

export interface UsageSummary {
  balance: { ok: boolean; cny: string | null };
  today: { calls: number; prompt: number; completion: number; cached: number; estimatedCalls: number };
  week: { calls: number; prompt: number; completion: number; cached: number };
  total: { calls: number; prompt: number; completion: number };
  days: { day: string; prompt: number; completion: number; calls: number }[];
  byLabel: { label: string; calls: number; prompt: number; completion: number }[];
  byModel: { model: string; calls: number; prompt: number; completion: number }[];
  recent: { at: string; label: string | null; model: string; prompt: number; completion: number; estimated: boolean }[];
}

export async function getUsageSummary(): Promise<UsageSummary> {
  const [today, week, total, days, byLabel, byModel] = await Promise.all([
    many<{ calls: number; prompt: number; completion: number; cached: number; estimated_calls: number }>(
      `select count(*)::int as calls,
              coalesce(sum(prompt_tokens),0)::int as prompt,
              coalesce(sum(completion_tokens),0)::int as completion,
              coalesce(sum(cached_tokens),0)::int as cached,
              count(*) filter (where estimated)::int as estimated_calls
         from llm_usage
        where at >= date_trunc('day', now() at time zone 'Asia/Shanghai') at time zone 'Asia/Shanghai'`,
    ),
    many<{ calls: number; prompt: number; completion: number; cached: number }>(
      `select count(*)::int as calls,
              coalesce(sum(prompt_tokens),0)::int as prompt,
              coalesce(sum(completion_tokens),0)::int as completion,
              coalesce(sum(cached_tokens),0)::int as cached
         from llm_usage
        where at >= now() - interval '7 days'`,
    ),
    many<{ calls: number; prompt: number; completion: number }>(
      `select count(*)::int as calls,
              coalesce(sum(prompt_tokens),0)::int as prompt,
              coalesce(sum(completion_tokens),0)::int as completion
         from llm_usage`,
    ),
    many<{ day: string; prompt: number; completion: number; calls: number }>(
      `select to_char(at at time zone 'Asia/Shanghai', 'MM-DD') as day,
              coalesce(sum(prompt_tokens),0)::int as prompt,
              coalesce(sum(completion_tokens),0)::int as completion,
              count(*)::int as calls
         from llm_usage
        where at >= now() - interval '7 days'
        group by 1
        order by 1`,
    ),
    many<{ label: string; calls: number; prompt: number; completion: number }>(
      `select coalesce(label,'(未标注)') as label,
              count(*)::int as calls,
              coalesce(sum(prompt_tokens),0)::int as prompt,
              coalesce(sum(completion_tokens),0)::int as completion
         from llm_usage
        where at >= now() - interval '7 days'
        group by 1
        order by (sum(prompt_tokens) + sum(completion_tokens)) desc
        limit 12`,
    ),
    many<{ model: string; calls: number; prompt: number; completion: number }>(
      `select model,
              count(*)::int as calls,
              coalesce(sum(prompt_tokens),0)::int as prompt,
              coalesce(sum(completion_tokens),0)::int as completion
         from llm_usage
        where at >= now() - interval '7 days'
        group by 1
        order by 2 desc`,
    ),
  ]);

  const recent = await many<{
    at: string;
    label: string | null;
    model: string;
    prompt: number;
    completion: number;
    estimated: boolean;
  }>(
    `select at, label, model, prompt_tokens as prompt, completion_tokens as completion, estimated
       from llm_usage order by at desc limit 12`,
  );

  return {
    balance: await fetchBalance(),
    today: {
      calls: today[0]?.calls ?? 0,
      prompt: today[0]?.prompt ?? 0,
      completion: today[0]?.completion ?? 0,
      cached: today[0]?.cached ?? 0,
      estimatedCalls: today[0]?.estimated_calls ?? 0,
    },
    week: week[0] ?? { calls: 0, prompt: 0, completion: 0, cached: 0 },
    total: total[0] ?? { calls: 0, prompt: 0, completion: 0 },
    days,
    byLabel,
    byModel,
    recent,
  };
}

/** 余额从服务商取（DeepSeek: GET /user/balance） */
export async function fetchBalance(): Promise<{ ok: boolean; cny: string | null }> {
  try {
    const { config } = await import('../config.js');
    const res = await fetch(`${config.chat.baseUrl}/user/balance`, {
      headers: { authorization: `Bearer ${config.chat.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, cny: null };
    const j = (await res.json()) as {
      balance_infos?: { currency: string; total_balance: string }[];
    };
    const cny = j.balance_infos?.find((b) => b.currency === 'CNY')?.total_balance ?? null;
    return { ok: true, cny };
  } catch {
    return { ok: false, cny: null };
  }
}
