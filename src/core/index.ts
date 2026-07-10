import { runScheduler } from "../scheduler/index.js";
import { GraphModule } from "../graph/index.js";
import { MemoryModule } from "../memory/index.js";
import { IdentityModule } from "../identity/index.js";
import { perceive } from "../perception/index.js";

/**
 * OpenCNS Core
 * System coordinator
 */

export async function runOpenCNS() {
  const perception = await perceive("system boot");

  const memoryFromPerception =
   await MemoryModule.storePerception(perception);

  const scheduler = await runScheduler();
  const graph = await GraphModule.run();
  const identity = await IdentityModule.run();

  return {
    status: "running",
    version: "0.1.0",

    perception,
    memoryFromPerception,

    scheduler,
    memory: await MemoryModule.lifecycle(),
    graph,
    identity,
  };
}
