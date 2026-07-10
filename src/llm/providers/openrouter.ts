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
                     this.config.model,

                   messages:
                     request.messages,

                   temperature:
                     0.7,

                   max_tokens:
                     2048

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
         await response.json() as OpenAICompatibleResponse;


        return {

            content:
                data.choices?.[0]
                ?.message?.content
                ||
                "No response"

        };
    }
}
