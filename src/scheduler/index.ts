import { MemoryModule } from "../memory/index.js";
import { ReflexModule } from "../reflex/index.js";

/**
 * OpenCNS Scheduler v2 (Reflex-driven loop)
 */

export async function runScheduler() {
  const cycles = [];

  let i = 0;

  while (true) {
    const memory = await MemoryModule.lifecycle();

    const reflex = await ReflexModule.run();

    cycles.push({
      cycle: i,
      memory,
      reflex,
    });

    i++;

    // 🧠 Reflex 决策: 是否继续
    if (reflex.decision === "stop" || i >= 3) {
      break;
    }
  }

  return {
    running: true,
    mode: "reflex-loop-v2",
    cycles,
  };
}