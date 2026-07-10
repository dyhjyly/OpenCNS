/**
 * Curiosity Module
 *
 * Generates exploration signals based on memory state.
 */

export async function runCuriosity() {
  return {
    enabled: true,
    signals: 0,
    status: "placeholder",
  };
}

export const CuriosityModule = {
  run: runCuriosity,
};
