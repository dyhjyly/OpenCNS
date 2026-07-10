import { handleChat } from "../src/gateway/index.js";

async function main() {

    const result = await handleChat({
        message: "我什么时候写代码？"
    });

    console.log(result);
}

main();
