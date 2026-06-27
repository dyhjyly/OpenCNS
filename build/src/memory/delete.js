"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleDeleteMemory = handleDeleteMemory;
const db_js_1 = require("../db.js");
const types_js_1 = require("./types.js");
const utils_js_1 = require("./utils.js");
async function handleDeleteMemory(args) {
    try {
        const { id } = types_js_1.DeleteMemorySchema.parse(args);
        const { data: existing, error: checkError } = await db_js_1.supabase
            .from('memories')
            .select('id')
            .eq('id', id)
            .single();
        if (checkError) {
            if (checkError.code === 'PGRST116') {
                return (0, utils_js_1.failure)(`Memory with ID '${id}' not found`);
            }
            return (0, utils_js_1.failure)(`Failed to check memory: ${checkError.message}`);
        }
        const { error: deleteError } = await db_js_1.supabase
            .from('memories')
            .delete()
            .eq('id', id);
        if (deleteError) {
            return (0, utils_js_1.failure)(`Failed to delete memory: ${deleteError.message}`);
        }
        return (0, utils_js_1.success)({
            success: true,
            message: `Memory '${id}' deleted successfully`,
        });
    }
    catch (error) {
        return (0, utils_js_1.failure)(error?.message ?? 'Unknown error');
    }
}
//# sourceMappingURL=delete.js.map