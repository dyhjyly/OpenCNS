import { config, type LlmEndpoint } from '../config.js';
import { log, errFields } from '../logger.js';
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
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
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
}

function pick(opts: ChatOptions): LlmEndpoint & { label: string } {
  const which = opts.endpoint ?? 'cognitive';
  const ep = which === 'chat' ? config.chat : config.cognitive;
  return { ...ep, label: opts.label ?? which };
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
  ep: LlmEndpoint,
  messages: ChatMessage[],
  opts: ChatOptions,
): Promise<{ text: string; usage: CompletionResponse['usage'] }> {
  if (!ep.baseUrl || !ep.apiKey || !ep.model) {
    throw new Error(`模型端点配置不完整（baseUrl/apiKey/model 有空值），拒绝发出 "undefined" 请求`);
  }

  const res = await fetch(`${ep.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${ep.apiKey}`,
    },
    body: JSON.stringify({
      model: opts.model ?? ep.model,
      messages,
      temperature: opts.temperature ?? 0.3,
      max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      stream: false,
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`模型返回 HTTP ${res.status}: ${body.slice(0, 300)}`);
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
