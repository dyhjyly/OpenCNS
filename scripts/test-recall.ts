import { runRecall } from "../src/recall/index.js";

async function main() {

    const result =
        await runRecall(
            "我们之前关于 OpenCNS 记忆系统的设计决定是什么？"
        );

    console.log(
        JSON.stringify(
            result,
            null,
            2
        )
    );
}

main().catch(error => {

    console.error(
        "[TEST RECALL ERROR]",
        error
    );

    process.exit(1);

});
