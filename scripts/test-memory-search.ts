import dotenv from "dotenv";
dotenv.config();

import { getEmbedding } from "../src/embedding.js";
import { supabase } from "../src/db.js";

async function main() {

    const query =
        "我们之前关于 OpenCNS 记忆系统的设计决定是什么？";

    console.log("\n[TEST] query:");
    console.log(query);

    const embedding =
        await getEmbedding(query);

    console.log("\n[TEST] embedding:");
    console.log("dimension =", embedding.length);
    console.log("first5 =", embedding.slice(0, 5));

    const {
        data,
        error
    } =
        await supabase.rpc(
            "search_memories_reflex",
            {
                query_embedding:
                    `[${embedding.join(",")}]`,

                match_limit:
                    20,
            }
        );

    console.log("\n[TEST] RPC error:");
    console.log(error);

    console.log("\n[TEST] result count:");
    console.log(data?.length ?? 0);

    console.log("\n[TEST] results:");

    console.log(
        JSON.stringify(
            data,
            null,
            2
        )
    );
}

main().catch(error => {

    console.error(
        "[TEST ERROR]",
        error
    );

    process.exit(1);

});
