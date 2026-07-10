/**
 * Pruning Module
 *
 * Remove memories that have permanently lost value.
 */

export async function runPruning() {
  return {
    enabled: true,
    pruned: 0,
    status: "placeholder",
  };
}

export const PruningModule = {
  run: runPruning,
};
