"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleSearchMemories = handleSearchMemories;
const db_js_1 = require("../db.js");
const embedding_js_1 = require("../embedding.js");
const types_js_1 = require("./types.js");
const utils_js_1 = require("./utils.js");
async function handleSearchMemories(args) {
    try {
        const { query, limit } = types_js_1.SearchMemoriesSchema.parse(args);
        const queryEmbedding = await (0, embedding_js_1.getEmbedding)(query);
        const { data, error } = await db_js_1.supabase.rpc('search_memories_reflex', {
            query_embedding: `[${queryEmbedding.join(',')}]`,
            match_limit: limit,
        });
        if (data?.length) {
            for (const item of data) {
                await db_js_1.supabase
                    .from('memories')
                    .update({
                    importance: Math.max(0, (item.importance ?? 0.5) * 0.98),
                })
                    .eq('id', item.id);
            }
        }
        if (error) {
            return (0, utils_js_1.failure)(`Failed to search memories: ${error.message}`);
        }
        return (0, utils_js_1.success)({
            success: true,
            query,
            results: data || [],
            count: data?.length || 0,
        });
    }
    catch (error) {
        return (0, utils_js_1.failure)(error?.message ?? 'Unknown error');
    }
}
//# sourceMappingURL=search.js.map