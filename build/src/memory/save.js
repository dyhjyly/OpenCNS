"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleSaveMemory = handleSaveMemory;
const db_js_1 = require("../db.js");
const embedding_js_1 = require("../embedding.js");
const analyzer_js_1 = require("../analyzer.js");
const types_js_1 = require("./types.js");
const utils_js_1 = require("./utils.js");
async function handleSaveMemory(args) {
    try {
        const { content, metadata, } = types_js_1.SaveMemorySchema.parse(args);
        const analysis = await (0, analyzer_js_1.analyzeMemory)(content);
        const embedding = await (0, embedding_js_1.getEmbedding)(content);
        const { data, error } = await db_js_1.supabase
            .from('memories')
            .insert({
            content,
            embedding,
            metadata,
            memory_type: analysis.memory_type,
            importance: analysis.importance,
            unresolved: analysis.unresolved,
        })
            .select('id, content, metadata, created_at')
            .single();
        if (error) {
            return (0, utils_js_1.failure)(`Failed to save memory: ${error.message}`);
        }
        return (0, utils_js_1.success)({
            success: true,
            message: 'Memory saved successfully',
            memory: {
                id: data.id,
                content: data.content,
                metadata: data.metadata,
                created_at: data.created_at,
            },
        });
    }
    catch (error) {
        return (0, utils_js_1.failure)(error?.message ?? 'Unknown error');
    }
}
//# sourceMappingURL=save.js.map