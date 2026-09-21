import {
    ConversationMessage
} from "./state.js";


export const SUMMARY_TRIGGER =
    20;


export const RECENT_MESSAGES_AFTER_COMPRESSION =
    8;


export interface ConversationSummaryInput {

    existingSummary: string;

    messages: ConversationMessage[];

}


export interface ConversationSummaryResult {

    summaryInput:
        ConversationSummaryInput;

    retainedMessages:
        ConversationMessage[];

}


export function buildSummaryInput(
    existingSummary: string,
    messages: ConversationMessage[]
): ConversationSummaryResult {

    if (
        messages.length <
        SUMMARY_TRIGGER
    ) {

        return {

            summaryInput: {

                existingSummary,

                messages: []

            },

            retainedMessages:
                messages

        };

    }


    const splitIndex =
        messages.length -
        RECENT_MESSAGES_AFTER_COMPRESSION;


    const messagesToCompress =
        messages.slice(
            0,
            splitIndex
        );


    const retainedMessages =
        messages.slice(
            splitIndex
        );


    return {

        summaryInput: {

            existingSummary,

            messages:
                messagesToCompress

        },

        retainedMessages

    };

}