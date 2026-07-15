export type ProviderName =
    | "openrouter"
    | "ollama"
    | "openai-compatible";


export interface ModelConfig {

    provider: ProviderName;

    model: string;

    chatModel?: string;

    analyzerModel?: string;

    memoryModel?: string;

    dreamModel?: string;

    identityModel?: string;

    baseUrl?: string;

    apiKey?: string;
}


/**
 * 主聊天模型
 *
 * 负责：
 * - 用户对话
 * - 推理
 * - 最终回复
 */
export const CHAT_MODEL_CONFIG: ModelConfig = {

    provider:
        (process.env.CHAT_PROVIDER ||
        "openai-compatible") as ProviderName,

    model:
        process.env.CHAT_MODEL ||
        "",

    chatModel:
        process.env.LLM_CHAT_MODEL ||
        process.env.CHAT_MODEL ||
        "",

    baseUrl:
        process.env.CHAT_BASE_URL,

    apiKey:
        process.env.CHAT_API_KEY,
};


/**
 * 认知模型
 *
 * 负责：
 * - Memory Analyzer
 * - Reflection
 * - Compression
 * - Dream
 */
export const COGNITIVE_MODEL_CONFIG: ModelConfig = {

    provider:
        (process.env.COGNITIVE_PROVIDER ||
        "openai-compatible") as ProviderName,

    model:
        process.env.COGNITIVE_MODEL ||
        "",

    analyzerModel:
        process.env.LLM_ANALYZER_MODEL ||
        process.env.COGNITIVE_MODEL ||
        "",

    memoryModel:
        process.env.LLM_MEMORY_MODEL ||
        process.env.COGNITIVE_MODEL ||
        "",

    dreamModel:
        process.env.LLM_DREAM_MODEL ||
        process.env.COGNITIVE_MODEL ||
        "",

    identityModel:
        process.env.LLM_IDENTITY_MODEL ||
        process.env.COGNITIVE_MODEL ||
        "",

    baseUrl:
        process.env.COGNITIVE_BASE_URL,

    apiKey:
        process.env.COGNITIVE_API_KEY,
};


/**
 * Embedding模型
 *
 * 负责：
 * - 向量生成
 */
export const EMBEDDING_MODEL_CONFIG: ModelConfig = {

    provider:
        (process.env.EMBED_PROVIDER ||
        "openai-compatible") as ProviderName,

    model:
        process.env.EMBED_MODEL ||
        "",

    baseUrl:
        process.env.EMBED_BASE_URL,

    apiKey:
        process.env.EMBED_API_KEY,
};
