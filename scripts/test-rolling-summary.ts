import {
    generateRollingSummary
} from "../src/conversation/summaryGenerator.js";


async function main() {

    const summary =
        await generateRollingSummary({

            existingSummary:
                "我们正在开发 OpenCNS，目前正在实现 Conversation Context。",

            messages: [

                {
                    id: "message-1",

                    role: "user",

                    content:
                        "我们现在先不要修改 Gateway，先把 Conversation State 做完整。",

                    createdAt:
                        new Date().toISOString()
                },

                {
                    id: "message-2",

                    role: "assistant",

                    content:
                        "好的，我们先实现 State、Recent Raw 和 Rolling Summary。",

                    createdAt:
                        new Date().toISOString()
                },

                {
                    id: "message-3",

                    role: "user",

                    content:
                        "验证通过以后再进入下一步，不要一次改太多东西。",

                    createdAt:
                        new Date().toISOString()
                }

            ]

        });


    console.log(
        "ROLLING SUMMARY:"
    );

    console.log(
        summary
    );


    if (
        !summary ||
        summary.trim().length === 0
    ) {

        throw new Error(
            "Rolling Summary is empty."
        );

    }


    console.log(
        "ROLLING SUMMARY TEST: PASS"
    );

}


main().catch(
    error => {

        console.error(
            "ROLLING SUMMARY TEST: FAIL"
        );

        console.error(
            error
        );

        process.exit(1);

    }
);
