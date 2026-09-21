export type ConversationRole =
    | "user"
    | "assistant";

export interface ConversationMessage {
    id: string;
    role: ConversationRole;
    content: string;
    createdAt: string;
}

export interface ConversationState {
    sessionId: string;
    createdAt: string;
    updatedAt: string;
    rollingSummary: string;
    recentMessages: ConversationMessage[];
}
