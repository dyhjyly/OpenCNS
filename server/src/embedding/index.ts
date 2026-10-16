import { config } from '../config.js';
import { log, errFields } from '../logger.js';

/**
 * Embedding provider。
 *
 * 默认走云 API（几乎不占服务器内存）；可一行配置切回本地 Ollama。
 * 两个 provider 共用同一个模型（bge-m3，1024 维）—— 维度必须与
 * memory_items.embedding 的列定义一致，否则向量根本没法比。
 */

export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dim: number;
  embed(texts: string[]): Promise<number[][]>;
}

const BATCH_SIZE = 32;
const MAX_RETRIES = 2;

function assertDim(name: string, vecs: number[][]): number[][] {
  for (const v of vecs) {
    if (!Array.isArray(v) || v.length !== config.embedding.dim) {
      throw new Error(
        `${name} 返回的向量维度是 ${Array.isArray(v) ? v.length : 'n/a'}，` +
          `但配置 EMBEDDING_DIM=${config.embedding.dim}。` +
          `维度不一致会导致检索彻底失效，拒绝继续。`,
      );
    }
  }
  return vecs;
}

async function postJson(url: string, body: unknown, headers: Record<string, string>) {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${text.slice(0, 300)}`);
      }
      return (await res.json()) as unknown;
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** 云 API：OpenAI 兼容的 /embeddings */
function createCloudProvider(): EmbeddingProvider {
  const { baseUrl, apiKey, model, dim } = config.embedding;
  return {
    name: 'cloud',
    model,
    dim,
    async embed(texts: string[]) {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += BATCH_SIZE) {
        const batch = texts.slice(i, i + BATCH_SIZE);
        const json = (await postJson(
          `${baseUrl}/embeddings`,
          { model, input: batch, encoding_format: 'float' },
          { authorization: `Bearer ${apiKey ?? ''}` },
        )) as { data?: { index?: number; embedding: number[] }[] };

        const rows = json.data ?? [];
        if (rows.length !== batch.length) {
          throw new Error(`embedding 返回条数不符：期望 ${batch.length}，得到 ${rows.length}`);
        }
        const ordered = [...rows].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        out.push(...ordered.map((r) => r.embedding));
      }
      return assertDim('cloud', out);
    },
  };
}

/** 本地 Ollama：/api/embed（Ollama ≥ 0.3） */
function createOllamaProvider(): EmbeddingProvider {
  const { ollamaBaseUrl, ollamaKeepAlive, model, dim } = config.embedding;
  return {
    name: 'ollama',
    model,
    dim,
    async embed(texts: string[]) {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += BATCH_SIZE) {
        const batch = texts.slice(i, i + BATCH_SIZE);
        const json = (await postJson(
          `${ollamaBaseUrl}/api/embed`,
          { model, input: batch, keep_alive: ollamaKeepAlive },
          {},
        )) as { embeddings?: number[][] };
        const rows = json.embeddings ?? [];
        if (rows.length !== batch.length) {
          throw new Error(`ollama 返回条数不符：期望 ${batch.length}，得到 ${rows.length}`);
        }
        out.push(...rows);
      }
      return assertDim('ollama', out);
    },
  };
}

let cached: EmbeddingProvider | null = null;

export function getEmbeddingProvider(): EmbeddingProvider {
  if (!cached) {
    cached = config.embedding.provider === 'ollama' ? createOllamaProvider() : createCloudProvider();
    log.info('embedding provider 就绪', {
      provider: cached.name,
      model: cached.model,
      dim: cached.dim,
    });
  }
  return cached;
}

export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  return getEmbeddingProvider().embed(texts);
}

export async function embedOne(text: string): Promise<number[]> {
  const [vec] = await embed([text]);
  if (!vec) throw new Error('embedding 返回为空');
  return vec;
}

/** 启动自检：真的能拿到一个正确维度的向量 */
export async function probeEmbedding(): Promise<{ provider: string; dim: number; ms: number }> {
  const provider = getEmbeddingProvider();
  const started = Date.now();
  try {
    const [vec] = await provider.embed(['启动自检：向量维度探针']);
    if (!vec) throw new Error('探针返回为空');
    return { provider: provider.name, dim: vec.length, ms: Date.now() - started };
  } catch (err) {
    log.error('embedding 自检失败', errFields(err));
    throw err;
  }
}
