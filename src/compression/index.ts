import { findCompressionCandidates } from "./engine.js";

/**
 * Compression Module
 */

export async function runCompression() {
  const groups = await findCompressionCandidates();

  if (groups.length === 0) {
    return {
      enabled: true,
      compressed: 0,
      message: "No candidates",
    };
  }

  return {
    enabled: true,
    compressed: groups.length,
    groups,
  };
}

export const CompressionModule = {
  run: runCompression,
};
