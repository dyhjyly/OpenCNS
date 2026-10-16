import { config, type LlmEndpoint } from '../config.js';
import { log, errFields } from '../logger.js';

/**
 * 模型调用封装（OpenAI 兼容 /chat/completions）。
 *
 * 现状里要解决的老问题：
 *   - 旧代码把 temperature / max_tokens 全局写死，对话与认知任务共用一套参数；
 *   - 没有超时、没有重试；JSON 解析失败就静默返回空（一次失败=整轮丢记忆）；
 *   - 各家 baseUrl 缺省时会把 "undefined/chat/completions" 发出去。
 * 这里统一收口，并且把"用了多少"记进日志，方便盯着月度预算。
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
  choices?: { message?: { content?: string; reasoning_content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

async function callOnce(
  ep: LlmEndpoint,
  messages: ChatMessage[],
  opts: ChatOptions,
): Promise<{ text: string; usage: CompletionResponse['usage'] }> {
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
      max_tokens: opts.maxTokens ?? 2048,
      // 明确不要流式：认知任务需要完整 JSON
      stream: false,
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`模型返回 HTTP ${res.status}: ${body.slice(0, 300)}`);
  }

  const json = (await res.json()) as CompletionResponse;
  const message = json.choices?.[0]?.message;
  // 注意：reasoning_content 是思维链，**绝不能**当作正文用（旧代码这么干过，
  // 会把思考过程当成回复写进记忆）。正文为空时宁可报错。
  const text = message?.content ?? '';
  if (!text.trim()) {
    throw new Error('模型返回了空正文（拒绝把 reasoning_content 当正文使用）');
  }
  return { text, usage: json.usage };
}

export async function chatText(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
  const ep = pick(opts);
  const retries = opts.retries ?? 2;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const started = Date.now();
    try {
      const { text, usage } = await callOnce(ep, messages, opts);
      log.debug('模型调用成功', {
        label: ep.label,
        model: opts.model ?? ep.model,
        attempt: attempt + 1,
        ms: Date.now() - started,
        promptTokens: usage?.prompt_tokens ?? null,
        completionTokens: usage?.completion_tokens ?? null,
        promptChars: messages.reduce((n, m) => n + m.content.length, 0),
        replyChars: text.length,
      });
      return text;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
    }
  }

  log.error('模型调用失败', { label: ep.label, ...errFields(lastErr) });
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** 从模型输出里抠出 JSON：容错 Markdown 围栏、前后废话、单对象/数组两种形状 */
export function extractJson<T>(text: string): T {
  const trimmed = text.trim();

  const tryParse = (s: string): T | undefined => {
    try {
      return JSON.parse(s) as T;
    } catch {
      return undefined;
    }
  };

  const direct = tryParse(trimmed);
  if (direct !== undefined) return direct;

  const noFence = trimmed.replace(/```json/gi, '').replace(/```/g, '').trim();
  const unfenced = tryParse(noFence);
  if (unfenced !== undefined) return unfenced;

  const firstObj = noFence.indexOf('{');
  const firstArr = noFence.indexOf('[');
  const start = [firstObj, firstArr].filter((i) => i >= 0).sort((a, b) => a - b)[0];
  if (start !== undefined) {
    const lastObj = noFence.lastIndexOf('}');
    const lastArr = noFence.lastIndexOf(']');
    const end = Math.max(lastObj, lastArr);
    if (end > start) {
      const sliced = tryParse(noFence.slice(start, end + 1));
      if (sliced !== undefined) return sliced;
    }
  }

  throw new Error(`无法从模型输出里解析出 JSON（前 200 字）：${text.slice(0, 200)}`);
}

export async function chatJson<T>(messages: ChatMessage[], opts: ChatOptions = {}): Promise<T> {
  const text = await chatText(messages, opts);
  return extractJson<T>(text);
}
