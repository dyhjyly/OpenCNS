import { supabase } from "../db.js";

/**
 * Compression Engine v1
 *
 * Finds candidate memories for future compression.
 */
export async function findCompressionCandidates(limit = 20) {
  const { data, error } = await supabase
    .from("memories")
    .select(`
      id,
      content,
      importance,
      memory_state,
      created_at
    `)
    .eq("memory_state", "active")
    .lt("importance", 0.4)
    .limit(limit);

  if (error) {
    throw new Error(`Compression query failed: ${error.message}`);
  }

const candidates = data ?? [];

if (candidates.length < 2) {
  return [];
}

return [
  {
    group: "default",
    memories: candidates,
  },
];   


   return data ?? [];
}
