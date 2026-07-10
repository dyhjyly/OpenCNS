import { runReflex } from "../reflex/index.js";
 import {
    buildReflexPrompt
  } from "../reflex/context/prompt.js";
import {
    chat,
    ChatMessage
} from "../llm/index.js";
import {
    handleSaveMemory
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

    const messages: ChatMessage[] = [
        {
            role: "system",
            content: buildReflexPrompt(context)
        },
        {
            role: "user",
            content: request.message
        }
    ];

    const response = await chat({
        messages
    });
   
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
