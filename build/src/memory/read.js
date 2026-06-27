"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleReadMemory = handleReadMemory;
const db_js_1 = require("../db.js");
const types_js_1 = require("./types.js");
const utils_js_1 = require("./utils.js");
async function handleReadMemory(args) {
    try {
        const { id } = types_js_1.ReadMemorySchema.parse(args);
        const { data, error } = await db_js_1.supabase
            .from('memories')
            .select('*')
            .eq('id', id)
            .single();
        if (!error && data) {
            await db_js_1.supabase
                .from('memories')
                .update({
                last_accessed: new Date().toISOString(),
                access_count: (data.access_count ?? 0) + 1,
            })
                .eq('id', id);
        }
        if (error) {
            if (error.code === 'PGRST116') {
                return (0, utils_js_1.failure)(`Memory with ID '${id}' not found`);
            }
            return (0, utils_js_1.failure)(`Failed to read memory: ${error.message}`);
        }
        return (0, utils_js_1.success)({
            success: true,
            memory: data,
        });
    }
    catch (error) {
        return (0, utils_js_1.failure)(error?.message ?? 'Unknown error');
    }
}
//# sourceMappingURL=read.js.map