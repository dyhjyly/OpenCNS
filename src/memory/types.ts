import { z } from 'zod';

export const SaveMemorySchema = z.object({

  content:
    z.string().min(1, 'Content is required'),

  memory_type:
    z.string().optional(),

  importance:
    z.number().optional().default(0.5),

  unresolved:
    z.boolean().optional().default(false),

  metadata:
    z.record(z.string(), z.unknown()).optional().default({}),

});

export const SearchMemoriesSchema = z.object({
  query: z.string().min(1, 'Query is required'),
  limit: z.number().int().min(1).max(50).optional().default(5),
});

export const ReadMemorySchema = z.object({
  id: z.string().uuid('Invalid memory ID format'),
});

export const DeleteMemorySchema = z.object({
  id: z.string().uuid('Invalid memory ID format'),
});
