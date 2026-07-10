import {
    ModelProvider
} from "./types.js";

import {
    CHAT_MODEL_CONFIG,
    COGNITIVE_MODEL_CONFIG,
    EMBEDDING_MODEL_CONFIG,
    ModelConfig
} from "./config.js";


import {
    OpenRouterProvider
} from "./providers/openrouter.js";


function createProvider(
    config: ModelConfig
): ModelProvider {

    switch(config.provider) {

        case "openrouter":

            return new OpenRouterProvider(
                config
            );


        case "openai-compatible":

            return new OpenRouterProvider(
                config
            );


        case "ollama":

            throw new Error(
                "Ollama provider not implemented yet"
            );


        default:

            throw new Error(
                `Unsupported provider: ${config.provider}`
            );
    }
}


export function getChatProvider() {

    return createProvider(
        CHAT_MODEL_CONFIG
    );
}


export function getCognitiveProvider() {

    return createProvider(
        COGNITIVE_MODEL_CONFIG
    );
}


export function getEmbeddingProvider() {

    return createProvider(
        EMBEDDING_MODEL_CONFIG
    );
}
