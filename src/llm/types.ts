export type ModelRole =
    | "system"
    | "user"
    | "assistant";

export interface ChatImage {
    type: "image_url";
    image_url: {
        url: string;
    };
}

export interface ChatFile {
    name: string;
    type: string;
    data: string;
}

export type ChatContent =
    | string
    | Array<
        | {
            type: "text";
            text: string;
        }
        | ChatImage
        | ChatFile
      >;

export interface ChatMessage {
    role: ModelRole;
    content: ChatContent;
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