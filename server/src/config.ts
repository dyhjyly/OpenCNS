import 'dotenv/config';
import { z } from 'zod';

/**
 * 配置在启动时一次性校验。
 * 任何缺失/非法都直接抛错 —— 宁可起不来，也不要带着半截配置跑起来写坏数据。
 */

const RawSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    TIMEZONE: z.string().default('Asia/Shanghai'),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL 必填'),
    DB_POOL_MAX: z.coerce.number().int().positive().max(50).default(5),

    // --- embedding ---
    EMBEDDING_PROVIDER: z.enum(['cloud', 'ollama']).default('cloud'),
    EMBEDDING_DIM: z.coerce.number().int().positive().default(1024),
    EMBEDDING_MODEL: z.string().default('BAAI/bge-m3'),
    EMBEDDING_BASE_URL: z.string().default('https://api.siliconflow.cn/v1'),
    EMBEDDING_API_KEY: z.string().optional(),
    OLLAMA_BASE_URL: z.string().default('http://127.0.0.1:11434'),
    OLLAMA_KEEP_ALIVE: z.string().default('5m'),

    // --- LLM ---
    CHAT_BASE_URL: z.string().default('https://api.deepseek.com/v1'),
    CHAT_API_KEY: z.string().min(1, 'CHAT_API_KEY 必填'),
    CHAT_MODEL: z.string().min(1, 'CHAT_MODEL 必填'),

    COGNITIVE_BASE_URL: z.string().optional(),
    COGNITIVE_API_KEY: z.string().optional(),
    COGNITIVE_MODEL: z.string().optional(),

    // --- 推送 ---
    PUSHPLUS_TOKEN: z.string().optional(),
    PUSHPLUS_BASE_URL: z.string().default('https://www.pushplus.plus'),

    // --- 行为开关 ---
    ALLOW_BOOT_WRITES: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
  })
  .superRefine((v, ctx) => {
    // cloud 模式下必须有 key，否则第一次向量化才会失败——太晚了
    if (v.EMBEDDING_PROVIDER === 'cloud' && !v.EMBEDDING_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['EMBEDDING_API_KEY'],
        message: 'EMBEDDING_PROVIDER=cloud 时必须提供 EMBEDDING_API_KEY',
      });
    }
    // 认知模型缺省时回落到主对话模型
    if (!v.COGNITIVE_BASE_URL) v.COGNITIVE_BASE_URL = v.CHAT_BASE_URL;
    if (!v.COGNITIVE_API_KEY) v.COGNITIVE_API_KEY = v.CHAT_API_KEY;
    if (!v.COGNITIVE_MODEL) v.COGNITIVE_MODEL = v.CHAT_MODEL;
  });

const parsed = RawSchema.safeParse(process.env);

if (!parsed.success) {
  const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
  // 这里还不能用 logger（logger 依赖 config）
  process.stderr.write(`配置校验失败，拒绝启动：\n${lines.join('\n')}\n`);
  process.exit(1);
}

const raw = parsed.data;

export interface LlmEndpoint {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export const config = {
  env: raw.NODE_ENV,
  isProduction: raw.NODE_ENV === 'production',
  port: raw.PORT,
  logLevel: raw.LOG_LEVEL,
  timezone: raw.TIMEZONE,

  database: {
    url: raw.DATABASE_URL,
    poolMax: raw.DB_POOL_MAX,
  },

  embedding: {
    provider: raw.EMBEDDING_PROVIDER,
    dim: raw.EMBEDDING_DIM,
    model: raw.EMBEDDING_MODEL,
    baseUrl: raw.EMBEDDING_BASE_URL.replace(/\/+$/, ''),
    apiKey: raw.EMBEDDING_API_KEY,
    ollamaBaseUrl: raw.OLLAMA_BASE_URL.replace(/\/+$/, ''),
    ollamaKeepAlive: raw.OLLAMA_KEEP_ALIVE,
  },

  chat: {
    baseUrl: raw.CHAT_BASE_URL.replace(/\/+$/, ''),
    apiKey: raw.CHAT_API_KEY,
    model: raw.CHAT_MODEL,
  } satisfies LlmEndpoint,

  cognitive: {
    baseUrl: (raw.COGNITIVE_BASE_URL ?? raw.CHAT_BASE_URL).replace(/\/+$/, ''),
    apiKey: raw.COGNITIVE_API_KEY ?? raw.CHAT_API_KEY,
    model: raw.COGNITIVE_MODEL ?? raw.CHAT_MODEL,
  } satisfies LlmEndpoint,

  push: {
    pushplusToken: raw.PUSHPLUS_TOKEN,
    pushplusBaseUrl: raw.PUSHPLUS_BASE_URL.replace(/\/+$/, ''),
  },

  allowBootWrites: raw.ALLOW_BOOT_WRITES,
} as const;

export type AppConfig = typeof config;
