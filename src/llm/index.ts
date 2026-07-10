import {
    ChatRequest,
    ChatResponse
} from "./types.js";

import {
    getChatProvider
} from "./provider.js";


export type {
    ChatMessage,
    ChatRequest,
    ChatResponse
} from "./types.js";


export async function chat(
    request: ChatRequest
): Promise<ChatResponse> {

    const provider =
        getChatProvider();


    return provider.chat(
        request
    );
}
