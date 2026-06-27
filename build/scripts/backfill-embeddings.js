"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const db_js_1 = require("../src/db.js");
const embedding_js_1 = require("../src/embedding.js");
async function main() {
    const { data, error } = await db_js_1.supabase
        .from('memories')
        .select('id, content')
        .is('embedding', null);
    if (error)
        throw error;
    console.log(`Need rebuild: ${data.length}`);
    for (const memory of data) {
        try {
            const embedding = await (0, embedding_js_1.getEmbedding)(memory.content);
            await db_js_1.supabase
                .from('memories')
                .update({ embedding })
                .eq('id', memory.id);
            console.log(`✓ ${memory.id}`);
        }
        catch (err) {
            console.error(`✗ ${memory.id}`);
        }
    }
    console.log('Done');
}
main();
//# sourceMappingURL=backfill-embeddings.js.map