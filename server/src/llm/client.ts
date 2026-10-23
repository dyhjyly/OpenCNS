import { config, type LlmEndpoint } from '../config.js';
import { log, errFields } from '../logger.js';
import { getSetting } from '../settings/index.js';
import { estimateTokens, recordUsage } from './usage.js';
import { extractJson } from './json.js';

export { extractJson, repairTruncatedJson } from './json.js';

/**
 * 模型调用封装（OpenAI 兼容 /chat/completions）。
 *
 * 现状里要解决的老问题：
 *   - 旧代码把 temperature / max_tokens 全局写死，对话与认知任务共用一套参数；
 *   - 没有超时、没有重试；JSON 解析失败就静默返回空（一次失败=整轮丢记忆）；
 *   - 各家 baseUrl 缺省时会把 "undefined/chat/completions" 发出去。
 *   - 把 reasoning_content 当正文用（会把思维链写进记忆）。
 * 这里统一收口，并把"用了多少"记进日志，方便盯着月度预算。
 *
 * 模型名与 effort 从运行时设置读（见 settings/），所以前端改完立刻生效，
 * 不用登服务器改 .env 重启。API key / baseUrl 仍然只在环境变量里。
 */

/** 多模态内容块：文本或图片（图片走 data URI 或 http URL） */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

export interface ChatOptions {
  /** 走哪个端点：对话模型还是认知模型 */
  endpoint?: 'chat' | 'cognitive';
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  retries?: number;
  /** 记账用的标签，例如 'compress' / 'recall-judge' / 'reply' */
  label?: string;
  /**
   * 强制调用某个工具（tool_choice = function）。
   * 用在"她明确让他记，但他没调 save_memory"这种必须落地的场合。
   */
  forceTool?: string;
}

type ResolvedEndpoint = LlmEndpoint & { label: string; effort?: string };

function pick(opts: ChatOptions): ResolvedEndpoint {
  const which = opts.endpoint ?? 'cognitive';
  const ep = which === 'chat' ? config.chat : config.cognitive;
  const cognitive = which === 'cognitive';

  const model =
    opts.model ??
    getSetting(cognitive ? 'llm.cognitive_model' : 'llm.chat_model', ep.model);
  const effort = getSetting<string | undefined>(
    cognitive ? 'llm.cognitive_effort' : 'llm.chat_effort',
    undefined,
  );

  return {
    ...ep,
    model,
    effort: effort && ['low', 'high', 'max'].includes(effort) ? effort : undefined,
    label: opts.label ?? which,
  };
}

interface CompletionResponse {
  choices?: { message?: { content?: string; reasoning_content?: string }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

/** 输出被长度上限截断（finish_reason = length）。必须单独识别：重试时要抬高上限，而不是原样重试。 */
export class TruncatedOutputError extends Error {
  constructor(public readonly chars: number) {
    super(`模型输出被长度上限截断（已生成 ${chars} 字符）`);
    this.name = 'TruncatedOutputError';
  }
}

const MAX_TOKENS_CEILING = 8000;
/** 推理型模型会把预算花在"思考"上，所以默认上限要够高（实测 700 会被吃光、正文返回空） */
const DEFAULT_MAX_TOKENS = 2048;

async function callOnce(
  ep: ResolvedEndpoint,
  messages: ChatMessage[],
  opts: ChatOptions,
): Promise<{ text: string; usage: CompletionResponse['usage'] }> {
  if (!ep.baseUrl || !ep.apiKey || !ep.model) {
    throw new Error(`模型端点配置不完整（baseUrl/apiKey/model 有空值），拒绝发出 "undefined" 请求`);
  }

  const body: Record<string, unknown> = {
    model: opts.model ?? ep.model,
    messages,
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    stream: false,
  };
  // 推理强度（low/high/max）。这是这个端点的扩展参数，不是 OpenAI 标准字段；
  // 万一换了网关不认，见下面的 400 兜底重试。
  if (ep.effort) body.effort = ep.effort;

  let res = await fetch(`${ep.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${ep.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
  });

  // effort 不被接受时去掉它重试一次，别因为一个可选参数把整条链路打死
  if (res.status === 400 && ep.effort) {
    const peek = await res.clone().text().catch(() => '');
    if (/effort/i.test(peek)) {
      log.warn('端点不认 effort 参数，去掉后重试', { label: ep.label });
      delete body.effort;
      res = await fetch(`${ep.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${ep.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
      });
    }
  }

  if (!res.ok) {
    const failBody = await res.text().catch(() => '');
    throw new Error(`模型返回 HTTP ${res.status}: ${failBody.slice(0, 300)}`);
  }

  const json = (await res.json()) as CompletionResponse;
  const choice = json.choices?.[0];
  const text = choice?.message?.content ?? '';
  const reasoning = choice?.message?.reasoning_content ?? '';

  if (!text.trim()) {
    // 推理型模型会把 max_tokens 花在"思考"上，正文因此为空。
    // 这不是"模型没说话"，而是**预算不够** —— 必须当成截断走高预算重试，
    // 否则整条链路会静默失效（实测踩过：欲望信号识别每一轮都失败）。
    if (choice?.finish_reason === 'length' || reasoning.length > 0) {
      throw new TruncatedOutputError(reasoning.length);
    }
    // 真正的空回复：宁可报错，也**绝不**把 reasoning_content 当正文用
    //（旧代码这么干过，等于把思维链当成回复写进记忆）。
    throw new Error('模型返回了空正文');
  }
  if (choice?.finish_reason === 'length') {
    throw new TruncatedOutputError(text.length);
  }
  return { text, usage: json.usage };
}

export async function chatText(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
  const ep = pick(opts);
  const retries = opts.retries ?? 2;
  let maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const started = Date.now();
    try {
      const { text, usage } = await callOnce(ep, messages, { ...opts, maxTokens });
      // 记账（精确值）：这条路径拿得到服务商返回的 usage
      recordUsage({
        endpoint: opts.endpoint ?? 'cognitive',
        model: opts.model ?? ep.model,
        label: ep.label,
        promptTokens: usage?.prompt_tokens ?? 0,
        completionTokens: usage?.completion_tokens ?? 0,
        cachedTokens: (usage as { prompt_cache_hit_tokens?: number } | undefined)?.prompt_cache_hit_tokens ?? 0,
        ms: Date.now() - started,
      });
      log.debug('模型调用成功', {
        label: ep.label,
        model: opts.model ?? ep.model,
        attempt: attempt + 1,
        ms: Date.now() - started,
        maxTokens,
        promptTokens: usage?.prompt_tokens ?? null,
        completionTokens: usage?.completion_tokens ?? null,
        promptChars: messages.reduce((n, m) => n + m.content.length, 0),
        replyChars: text.length,
      });
      return text;
    } catch (err) {
      lastErr = err;
      if (err instanceof TruncatedOutputError && maxTokens < MAX_TOKENS_CEILING) {
        // 关键：被截断时不能原样重试，必须抬高上限（上限内翻倍）
        maxTokens = Math.min(MAX_TOKENS_CEILING, maxTokens * 2);
        log.warn('输出被截断，抬高上限重试', { label: ep.label, maxTokens, attempt: attempt + 1 });
        continue;
      }
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
    }
  }

  log.error('模型调用失败', { label: ep.label, maxTokens, ...errFields(lastErr) });
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function chatJson<T>(messages: ChatMessage[], opts: ChatOptions = {}): Promise<T> {
  const text = await chatText(messages, opts);
  return extractJson<T>(text);
}

/* ─────────── 工具调用 ─────────── */

export interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * 带工具的一次调用（非流式）。
 *
 * 用来做"按需查数据"：她想让他看步数/经期，他说"我查一下"就该真去查，
 * 而不是凭印象猜。模型返回 tool_calls 时不产出正文，由调用方执行后再问一次。
 */
export async function chatWithTools(
  messages: ChatMessage[],
  tools: ToolDef[],
  opts: ChatOptions = {},
): Promise<{ content: string; toolCalls: ToolCall[] }> {
  const ep = pick({ ...opts, label: opts.label ?? 'tools' });
  if (!ep.baseUrl || !ep.apiKey || !ep.model) throw new Error('模型端点配置不完整');

  const body: Record<string, unknown> = {
    model: opts.model ?? ep.model,
    messages,
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens ?? 800,
    stream: false,
    tools,
    tool_choice: opts.forceTool
      ? { type: 'function', function: { name: opts.forceTool } }
      : 'auto',
  };
  if (ep.effort) body.effort = ep.effort;

  const started = Date.now();
  const res = await fetch(`${ep.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ep.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`工具调用 HTTP ${res.status}: ${t.slice(0, 200)}`);
  }

  const json = (await res.json()) as {
    choices?: {
      message?: {
        content?: string;
        tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
      };
    }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number };
  };

  recordUsage({
    endpoint: opts.endpoint ?? 'chat',
    model: opts.model ?? ep.model,
    label: ep.label,
    promptTokens: json.usage?.prompt_tokens ?? 0,
    completionTokens: json.usage?.completion_tokens ?? 0,
    cachedTokens: json.usage?.prompt_cache_hit_tokens ?? 0,
    ms: Date.now() - started,
  });

  const msg = json.choices?.[0]?.message;
  const toolCalls: ToolCall[] = (msg?.tool_calls ?? [])
    .filter((c) => c?.function?.name)
    .map((c, i) => ({
      id: c.id ?? `call_${i}`,
      name: String(c.function?.name),
      arguments: String(c.function?.arguments ?? '{}'),
    }));

  return { content: msg?.content ?? '', toolCalls };
}

/** 端点实际支持哪些模型（用于设置接口的白名单校验，避免把错字写进库） */export async function listModels(): Promise<string[]> {
  const ep = pick({ endpoint: 'chat' });
  if (!ep.baseUrl || !ep.apiKey) throw new Error('端点配置不完整，无法列模型');
  const res = await fetch(`${ep.baseUrl}/models`, {
    headers: { authorization: `Bearer ${ep.apiKey}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`列模型失败 HTTP ${res.status}`);
  const json = (await res.json()) as { data?: { id: string }[] };
  return (json.data ?? []).map((m) => m.id);
}

/**
 * 流式调用（SSE）。
 *
 * 为什么要它：主模型是推理型的，完整一轮可能要几十秒。总量不会因为流式变小，
 * 但**第一个字**可以在一两秒内出来 —— 感知延迟天差地别。
 *
 * 注意：这里不重试。流式一旦开始推送，重试会把已经吐出去的文字重复一遍。
 */
export async function chatTextStream(
  messages: ChatMessage[],
  opts: ChatOptions,
  onDelta: (text: string) => void,
  onReasoning?: (text: string) => void,
): Promise<string> {
  const ep = pick({ ...opts, label: opts.label ?? 'stream' });
  if (!ep.baseUrl || !ep.apiKey || !ep.model) {
    throw new Error('模型端点配置不完整（baseUrl/apiKey/model 有空值）');
  }
  const started = Date.now();

  const body: Record<string, unknown> = {
    model: opts.model ?? ep.model,
    messages,
    temperature: opts.temperature ?? 0.8,
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    stream: true,
    // 关键：不带这个，流式响应里就没有 usage —— 只能按字数瞎估，
    // 缓存命中率永远显示 0（实际可能命中）。
    stream_options: { include_usage: true },
  };
  if (ep.effort) body.effort = ep.effort;

  let res = await fetch(`${ep.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${ep.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 300_000),
  });

  if (res.status === 400 && ep.effort) {
    const peek = await res.clone().text().catch(() => '');
    if (/effort/i.test(peek)) {
      log.warn('端点不认 effort 参数，去掉后重试（流式）', { label: ep.label });
      delete body.effort;
      res = await fetch(`${ep.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${ep.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 300_000),
      });
    }
  }

  if (!res.ok || !res.body) {
    const failBody = await res.text().catch(() => '');
    throw new Error(`模型流式返回 HTTP ${res.status}: ${failBody.slice(0, 300)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let reasoningChars = 0;
  /** 流式最后一帧会带真实 usage（前提是请求里要 include_usage） */
  let streamUsage: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } } | null = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r/g, '');

    let sep = buffer.indexOf('\n\n');
    while (sep >= 0) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);

      for (const rawLine of frame.split('\n')) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload) as {
            choices?: { delta?: { content?: string; reasoning_content?: string } }[];
            usage?: {
              prompt_tokens?: number;
              completion_tokens?: number;
              prompt_cache_hit_tokens?: number;
              completion_tokens_details?: { reasoning_tokens?: number };
            };
          };
          if (json.usage) streamUsage = json.usage;
          const delta = json.choices?.[0]?.delta;
          if (delta?.reasoning_content) {
            reasoningChars += delta.reasoning_content.length;
            if (onReasoning) onReasoning(delta.reasoning_content);
          }
          const piece = delta?.content ?? '';
          if (piece) {
            full += piece;
            onDelta(piece);
          }
        } catch {
          /* 半截的帧忽略即可，下一轮会拼上 */
        }
      }
      sep = buffer.indexOf('\n\n');
    }
  }

  /*
   * 空回复兜底。
   *
   * 实测会偶发：推理吃掉预算、正文一个字都没吐出来。这在她那边表现为"他忽然不说话了"。
   * 所以这里自动改用**非流式**重试一次（只多花一次调用），拿到正文再当成一整段 delta 吐出去。
   */
  if (!full.trim()) {
    log.warn('流式返回为空，改用非流式重试一次', { label: ep.label, reasoningChars });
    try {
      const retry = await chatText(messages, { ...opts, label: `${ep.label}-retry` });
      if (retry.trim()) {
        onDelta(retry);
        return retry;
      }
    } catch (err) {
      log.error('空回复重试也失败了', errFields(err));
    }
    throw new Error(`流式返回为空（推理内容 ${reasoningChars} 字，可能预算被思考吃光）`);
  }

  log.debug('流式调用完成', {
    label: ep.label,
    replyChars: full.length,
    reasoningChars,
    promptChars: messages.reduce(
      (n, m) =>
        n +
        (typeof m.content === 'string'
          ? m.content.length
          : m.content.reduce((k, p) => k + (p.type === 'text' ? p.text.length : 0), 0)),
      0,
    ),
  });

  // 流式拿不到精确 usage，按字数估一个，标记 estimated
  const promptChars = messages.reduce(
    (n, m) =>
      n +
      (typeof m.content === 'string'
        ? m.content.length
        : m.content.reduce((k, p) => k + (p.type === 'text' ? p.text.length : 0), 0)),
    0,
  );
  recordUsage({
    endpoint: opts.endpoint ?? 'chat',
    model: opts.model ?? ep.model,
    label: ep.label,
    // 拿到真实 usage 就用真的；拿不到（端点不认 include_usage）才退回字数估算
    promptTokens: streamUsage?.prompt_tokens ?? Math.round(promptChars * 0.95),
    completionTokens: streamUsage?.completion_tokens ?? estimateTokens(full),
    cachedTokens: streamUsage?.prompt_cache_hit_tokens ?? 0,
    reasoningTokens: streamUsage?.completion_tokens_details?.reasoning_tokens ?? Math.round(reasoningChars * 0.95),
    estimated: !streamUsage,
    ms: Date.now() - started,
  });

  return full;
}
