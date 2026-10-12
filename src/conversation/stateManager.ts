import {
    ConversationMessage,
    ConversationState
} from "./state.js";

import {
    loadRecentMessages,
    saveRecentMessage,
    trimRecentMessages
} from "./store.js";


class ConversationStateManager {

    private states:
    Map<string, ConversationState> =
        new Map();


    async create(
        sessionId: string
    ): Promise<ConversationState> {

        const recentMessages =
            await loadRecentMessages(
                sessionId
            );

        const now =
            new Date().toISOString();

        const state: ConversationState = {

            sessionId,

            createdAt:
                now,

            updatedAt:
                now,

            recentMessages

        };


        this.states.set(
            sessionId,
            state
        );


        return state;

    }


    async get(
        sessionId: string
    ): Promise<ConversationState | undefined> {

        return this.states.get(
            sessionId
        );

    }


    async addMessage(
        sessionId: string,
        message: ConversationMessage
    ): Promise<ConversationState> {

        let state =
            this.states.get(
                sessionId
            );


        if (!state) {

            state =
                await this.create(
                    sessionId
                );

        }


        const nextSequence =
            state.recentMessages.length > 0
                ? state.recentMessages[
                    state.recentMessages.length - 1
                ].createdAt === message.createdAt
                    ? state.recentMessages.length
                    : Date.now()
                : Date.now();


        await saveRecentMessage(
            sessionId,
            message,
            nextSequence
        );


        state.recentMessages.push(
            message
        );


        if (
            state.recentMessages.length > 60
        ) {

            state.recentMessages =
                state.recentMessages.slice(
                    -60
                );

        }


        await trimRecentMessages(
            sessionId
        );


        state.updatedAt =
            new Date().toISOString();


        return state;

    }

}


export const conversationState =
    new ConversationStateManager();