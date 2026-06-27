"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeleteMemorySchema = exports.ReadMemorySchema = exports.SearchMemoriesSchema = exports.SaveMemorySchema = void 0;
const zod_1 = require("zod");
exports.SaveMemorySchema = zod_1.z.object({
    content: zod_1.z.string().min(1, 'Content is required'),
    memory_type: zod_1.z.string().optional().default('fact'),
    importance: zod_1.z.number().optional().default(0.5),
    unresolved: zod_1.z.boolean().optional().default(false),
    metadata: zod_1.z.record(zod_1.z.string(), zod_1.z.unknown()).optional().default({}),
});
exports.SearchMemoriesSchema = zod_1.z.object({
    query: zod_1.z.string().min(1, 'Query is required'),
    limit: zod_1.z.number().int().min(1).max(50).optional().default(5),
});
exports.ReadMemorySchema = zod_1.z.object({
    id: zod_1.z.string().uuid('Invalid memory ID format'),
});
exports.DeleteMemorySchema = zod_1.z.object({
    id: zod_1.z.string().uuid('Invalid memory ID format'),
});
//# sourceMappingURL=types.js.map