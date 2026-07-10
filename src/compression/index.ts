
import { CompressionGroup } from "./types.js";
import { findCompressionCandidates } from "./engine.js";
import { generateCompressionSummary } from "./generator.js";
import { MemoryModule } from "../memory/index.js";
import { supabase } from "../db.js";

/**
 * Compression Module
 */

export async function runCompression() {
  const groups: CompressionGroup[] =
  await findCompressionCandidates();

  if (groups.length === 0) {
    return {
      enabled: true,
      compressed: 0,
      message: "No candidates",
    };
  }

const summaries = [];

for (const group of groups) {
  const summary = generateCompressionSummary(
    group.memories
  );

  const saved = await MemoryModule.save({
    content: summary,
    metadata: {
      source: "compression",
      compressed_from: group.memories.map(
        (m) => m.id
      ),
    },
  });

  summaries.push(saved);

  await supabase
    .from("memories")
    .update({
      memory_state: "compressed",
    })
    .in(
      "id",
      group.memories.map(
        (m) => m.id
      )
    );
}

  return {
   enabled: true,
   compressed: summaries.length,
   summaries,
 };
}

export const CompressionModule = {
  run: runCompression,
};
