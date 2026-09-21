import {
    conversationState
} from "../src/conversation/index.js";

import {
    buildSummaryInput
} from "../src/conversation/summary.js";


async function main() {

    const sessionId =
        "test-session-summary";


    await conversationState.create(
        sessionId
    );


    /*
     * Add 25 messages
     */

    for (
        let i = 1;
        i <= 25;
        i++
    ) {

        await conversationState.addMessage(
            sessionId,
            {
                id:
                    `message-${i}`,

                role:
                    i % 2 === 1
                        ? "user"
                        : "assistant",

                content:
                    `测试消息 ${i}`,

                createdAt:
                    new Date().toISOString()
            }
        );

    }


    const state =
        await conversationState.get(
            sessionId
        );


    if (!state) {

        throw new Error(
            "Conversation State was not found."
        );

    }


    /*
     * Recent Raw should already be bounded
     * to the newest 20 messages.
     */

    if (
        state.recentMessages.length !== 20
    ) {

        throw new Error(
            "Expected 20 recent messages."
        );

    }


    if (
        state.recentMessages[0].id !==
        "message-6"
    ) {

        throw new Error(
            "Expected message-6 as oldest recent message."
        );

    }


    if (
        state.recentMessages[19].id !==
        "message-25"
    ) {

        throw new Error(
            "Expected message-25 as newest recent message."
        );

    }


    /*
     * Build Summary Input
     */

    const result =
        buildSummaryInput(
            "这是已有的 Rolling Summary。",
            state.recentMessages
        );


    /*
     * 20 messages
     * -> first 12 compressed
     * -> last 8 retained
     */

    if (
        result.summaryInput.messages.length !==
        12
    ) {

        throw new Error(
            "Expected 12 messages for summary input."
        );

    }


    if (
        result.retainedMessages.length !==
        8
    ) {

        throw new Error(
            "Expected 8 retained messages."
        );

    }


    if (
        result.summaryInput.messages[0].id !==
        "message-6"
    ) {

        throw new Error(
            "Expected message-6 as first summary message."
        );

    }


    if (
        result.summaryInput.messages[11].id !==
        "message-17"
    ) {

        throw new Error(
            "Expected message-17 as last summary message."
        );

    }


    if (
        result.retainedMessages[0].id !==
        "message-18"
    ) {

        throw new Error(
            "Expected message-18 as first retained message."
        );

    }


    if (
        result.retainedMessages[7].id !==
        "message-25"
    ) {

        throw new Error(
            "Expected message-25 as last retained message."
        );

    }


    /*
     * Existing summary must be preserved
     * as summary input.
     */

    if (
        result.summaryInput.existingSummary !==
        "这是已有的 Rolling Summary。"
    ) {

        throw new Error(
            "Existing rolling summary was not preserved."
        );

    }


    /*
     * Below threshold should not compress.
     */

    const smallInput =
        buildSummaryInput(
            "",
            state.recentMessages.slice(
                -10
            )
        );


    if (
        smallInput.summaryInput.messages.length !==
        0
    ) {

        throw new Error(
            "Summary should not trigger below threshold."
        );

    }


    if (
        smallInput.retainedMessages.length !==
        10
    ) {

        throw new Error(
            "All messages should be retained below threshold."
        );

    }


    console.log(
        "SUMMARY INPUT TEST: PASS"
    );

}


main().catch(
    error => {

        console.error(
            "SUMMARY INPUT TEST: FAIL"
        );

        console.error(
            error
        );

        process.exit(1);

    }
);