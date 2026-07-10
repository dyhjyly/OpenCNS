import { z } from 'zod';

// ============================
// Save Memory
// ============================
export const SaveMemorySchema = z.object({
  content: z.string().min(1),
  metadata: z.record(z.string(), z.any()).optional().default({}),
});

// ============================
// Search Memory
// ============================
export const SearchMemoriesSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).default(5),
});

// ============================
// Read Memory
// ============================
export const ReadMemorySchema = z.object({
  id: z.string().uuid(),
});

// ============================
// Delete Memory
// ============================
export const DeleteMemorySchema = z.object({
  id: z.string().uuid(),
});

// ============================
// Decay Tool
// ============================
export const RunDecaySchema = z.object({
  batchSize: z.number().int().min(1).max(500).default(50),
});
