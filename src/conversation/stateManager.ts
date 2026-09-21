import {
    ConversationMessage,
    ConversationState
} from "./state.js";

import {
    buildSummaryInput
} from "./summary.js";

import {
    generateRollingSummary
} from "./summaryGenerator.js";


const MAX_RECENT_MESSAGES = 20;

class ConversationStateManager {

    private states:
    Map<string, ConversationState> =
        new Map();


    async create(
        sessionId: string
    ): Promise<ConversationState> {

        const now =
            new Date().toISOString();

        const state: ConversationState = {

            sessionId,

            createdAt:
                now,

            updatedAt:
                now,

            rollingSummary:
                "",

            recentMessages:
                []

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

        const state =
            this.states.get(
                sessionId
            );


        if (!state) {

            throw new Error(
                `Conversation state not found: ${sessionId}`
            );

        }


        state.recentMessages.push(
          message
        );

        if (
           state.recentMessages.length >
           MAX_RECENT_MESSAGES
        ) {

        state.recentMessages =
            state.recentMessages.slice(
                -MAX_RECENT_MESSAGES
            );

        }


        state.updatedAt =
            new Date().toISOString();


        return state;

    }


async getSummary(
    sessionId: string
): Promise<string> {

    const state =
        this.states.get(
            sessionId
        );


    if (!state) {

        throw new Error(
            `Conversation state not found: ${sessionId}`
        );

    }


    return state.rollingSummary;

}

    async compressIfNeeded(
    sessionId: string
): Promise<ConversationState> {

    const state =
        this.states.get(
            sessionId
        );


    if (!state) {

        throw new Error(
            `Conversation state not found: ${sessionId}`
        );

    }


    const result =
        buildSummaryInput(
            state.rollingSummary,
            state.recentMessages
        );


    if (
        result.summaryInput.messages.length === 0
    ) {

        return state;

    }


    const summary =
        await generateRollingSummary(
            result.summaryInput
        );


    state.rollingSummary =
        summary;


    state.recentMessages =
        result.retainedMessages;


    state.updatedAt =
        new Date().toISOString();


    return state;

}

    async updateSummary(
        sessionId: string,
        summary: string
    ): Promise<ConversationState> {

        const state =
            this.states.get(
                sessionId
            );


        if (!state) {

            throw new Error(
                `Conversation state not found: ${sessionId}`
            );

        }


        state.rollingSummary =
            summary;


        state.updatedAt =
            new Date().toISOString();


        return state;

    }

}


export const conversationState =
    new ConversationStateManager();
