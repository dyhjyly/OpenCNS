import { runReflex } from "../src/reflex/index.js";

async function main() {

    const result = await runReflex(
        "OpenCNS Memory"
    );

    console.log(
        JSON.stringify(
            result,
            null,
            2
        )
    );
}

main();