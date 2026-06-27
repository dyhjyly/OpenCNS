import { z } from 'zod';
export declare const SaveMemorySchema: z.ZodObject<{
    content: z.ZodString;
    memory_type: z.ZodDefault<z.ZodOptional<z.ZodString>>;
    importance: z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
    unresolved: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    metadata: z.ZodDefault<z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
}, z.core.$strip>;
export declare const SearchMemoriesSchema: z.ZodObject<{
    query: z.ZodString;
    limit: z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
}, z.core.$strip>;
export declare const ReadMemorySchema: z.ZodObject<{
    id: z.ZodString;
}, z.core.$strip>;
export declare const DeleteMemorySchema: z.ZodObject<{
    id: z.ZodString;
}, z.core.$strip>;
//# sourceMappingURL=types.d.ts.map