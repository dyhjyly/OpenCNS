export type ConversationRole =
    | "user"
    | "assistant";


export interface ConversationMessage {

    id: string;

    role:
    | "user"
    | "assistant";

    content: string;

    createdAt: string;

}


export interface ConversationState {

    sessionId: string;

    createdAt: string;

    updatedAt: string;

    recentMessages:
        ConversationMessage[];

}