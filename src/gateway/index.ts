import { runReflex } from "../reflex/index.js";
import {
    buildReflexPrompt
} from "../reflex/context/prompt.js";

import {
    chat,
    ChatMessage
} from "../llm/index.js";

import {
    handleSaveMemory,
    handleSearchMemories
} from "../memory/index.js";


export interface ChatRequest {
    message: string;
}

export interface ChatResponse {
    reply: string;
}


export async function handleChat(
    request: ChatRequest
): Promise<ChatResponse> {

    const context = await runReflex(
        request.message
    );


    // 搜索长期记忆
    const memories = await handleSearchMemories({
        query: request.message,
    });


    const memoryContext = Array.isArray(memories)
        ? memories
            .map((m: { content?: string }) => `- ${m.content ?? ""}`)
            .join("\n")
        : "";


    const messages: ChatMessage[] = [
        {
            role: "system",
            content:
                buildReflexPrompt(context)
                +
                (
                    memoryContext
                        ? "\n\n以下是相关长期记忆，请自然利用，不要逐条复述。\n\n"
                        + memoryContext
                        : ""
                )
        },
        {
            role: "user",
            content: request.message
        }
    ];


    const response = await chat({
        messages
    });


    // 保存当前对话记忆
    await handleSaveMemory({
        content: request.message,
        metadata: {
            source: "gateway",
        }
    });


    return {
        reply: response.content
    };
}