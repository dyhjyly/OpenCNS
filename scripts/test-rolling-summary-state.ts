import {
    conversationState
} from "../src/conversation/index.js";


async function addMessage(
    sessionId: string,
    number: number
) {

    await conversationState.addMessage(
        sessionId,
        {
            id:
                `message-${number}`,

            role:
                number % 2 === 1
                    ? "user"
                    : "assistant",

            content:
                `这是第 ${number} 条测试消息，用于验证 Rolling Summary 的连续压缩能力。`,

            createdAt:
                new Date().toISOString()
        }
    );

}


async function main() {

    const sessionId =
        "test-rolling-summary-state";


    await conversationState.create(
        sessionId
    );


    /*
     * First batch
     */

    for (
        let i = 1;
        i <= 20;
        i++
    ) {

        await addMessage(
            sessionId,
            i
        );

    }


    let state =
        await conversationState.compressIfNeeded(
            sessionId
        );


    if (
        !state.rollingSummary ||
        state.rollingSummary.trim().length === 0
    ) {

        throw new Error(
            "First rolling summary was not generated."
        );

    }


    if (
        state.recentMessages.length !== 8
    ) {

        throw new Error(
            "Expected 8 recent messages after first compression."
        );

    }


    if (
        state.recentMessages[0].id !==
        "message-13"
    ) {

        throw new Error(
            "Expected message-13 as first retained message."
        );

    }


    if (
        state.recentMessages[7].id !==
        "message-20"
    ) {

        throw new Error(
            "Expected message-20 as last retained message."
        );

    }


    const firstSummary =
        state.rollingSummary;


    console.log(
        "FIRST SUMMARY:"
    );

    console.log(
        firstSummary
    );


    /*
     * Second batch
     */

    for (
        let i = 21;
        i <= 32;
        i++
    ) {

        await addMessage(
            sessionId,
            i
        );

    }


    state =
        await conversationState.compressIfNeeded(
            sessionId
        );


    if (
        !state.rollingSummary ||
        state.rollingSummary.trim().length === 0
    ) {

        throw new Error(
            "Second rolling summary was not generated."
        );

    }


    if (
        state.recentMessages.length !== 8
    ) {

        throw new Error(
            "Expected 8 recent messages after second compression."
        );

    }


    if (
        state.recentMessages[0].id !==
        "message-25"
    ) {

        throw new Error(
            "Expected message-25 as first retained message."
        );

    }


    if (
        state.recentMessages[7].id !==
        "message-32"
    ) {

        throw new Error(
            "Expected message-32 as last retained message."
        );

    }


    const secondSummary =
        state.rollingSummary;


    console.log(
        "SECOND SUMMARY:"
    );

    console.log(
        secondSummary
    );


    if (
        secondSummary.trim().length === 0
    ) {

        throw new Error(
            "Second summary is empty."
        );

    }


    console.log(
        "ROLLING SUMMARY STATE TEST: PASS"
    );

}


main().catch(
    error => {

        console.error(
            "ROLLING SUMMARY STATE TEST: FAIL"
        );

        console.error(
            error
        );

        process.exit(1);

    }
);
