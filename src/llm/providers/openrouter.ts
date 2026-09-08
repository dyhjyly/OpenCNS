import {
    ChatRequest,
    ChatResponse,
    ModelProvider
} from "../types.js";

import {
    ModelConfig
} from "../config.js";


interface OpenAICompatibleResponse {

    choices?: Array<{

        message?: {

            content?: string;

        };

    }>;

    usage?: {

        prompt_tokens?: number;

        completion_tokens?: number;

        total_tokens?: number;

        prompt_cache_hit_tokens?: number;

        prompt_cache_miss_tokens?: number;

    };

}


export class OpenRouterProvider
implements ModelProvider {


    private config: ModelConfig;


    constructor(
        config: ModelConfig
    ) {

        this.config = config;

    }


    async chat(
        request: ChatRequest
    ): Promise<ChatResponse> {


        const response =
            await fetch(
                `${this.config.baseUrl}/chat/completions`,
                {
                    method: "POST",

                    headers: {

                        "Content-Type":
                            "application/json",

                        Authorization:
                            `Bearer ${this.config.apiKey}`

                    },

                    body: JSON.stringify({

                        model:
                            request.model ??
                            this.config.chatModel,

                        messages:
                            request.messages,

                        temperature:
                            0.2,

                        max_tokens:
                            8192

                    })

                }

            );


        if (!response.ok) {

            const errorText =
                await response.text();

            throw new Error(
                `Model API Error: ${response.status} ${errorText}`
            );

        }


        const data =
            (await response.json()) as OpenAICompatibleResponse;

        /*
         * DeepSeek Prompt Cache
         */

        const usage =
            data.usage;


        if (usage) {

            const hit =
                usage.prompt_cache_hit_tokens ?? 0;

            const miss =
                usage.prompt_cache_miss_tokens ?? 0;

            const cachedInput =
                hit + miss;

            const hitRate =
                cachedInput > 0
                    ? hit / cachedInput
                    : 0;


            console.log(
                "[LLM CACHE]",
                JSON.stringify({

                    promptTokens:
                        usage.prompt_tokens,

                    completionTokens:
                        usage.completion_tokens,

                    totalTokens:
                        usage.total_tokens,

                    cacheHitTokens:
                        hit,

                    cacheMissTokens:
                        miss,

                    cacheHitRate:
                        `${(hitRate * 100).toFixed(2)}%`

                })

            );

        } else {

            console.log(
                "[LLM CACHE] usage unavailable"
            );

        }


        const message =
            data.choices?.[0]?.message;


        const content =
            message?.content ||
            (message as any)?.reasoning_content;


        if (!content) {

            console.error(
                "[LLM] Invalid model response:",
                JSON.stringify(
                    data,
                    null,
                    2
                )
            );

            throw new Error(
                "Model returned no message content"
            );

        }


        return {

            content

        };

    }

}