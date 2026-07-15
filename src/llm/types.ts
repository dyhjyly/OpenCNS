export type ModelRole =
    | "system"
    | "user"
    | "assistant";

export interface ChatMessage {
    role: ModelRole;
    content: string;
}

export interface ChatRequest {
    model?: string;
    messages: ChatMessage[];
}

export interface ChatResponse {
    content: string;
}

export interface ModelProvider {
    chat(
        request: ChatRequest
    ): Promise<ChatResponse>;
}

