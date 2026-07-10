
import { CompressionModule } from "../compression/index.js";
import { DreamModule } from "../dream/index.js";
import { PruningModule } from "../pruning/index.js";
import { runMemoryDecay } from './decayEngine.js';
import { runMemoryArchive } from './archive.js';

/**
 * 🧠 Memory Lifecycle Controller
 */
export async function runLifecycle() {
  const decay = await runMemoryDecay(50);

  const compression = await CompressionModule.run();

  const archive = await runMemoryArchive(0.2);

  const dream = await DreamModule.run();

  const pruning = await PruningModule.run();

  return {
    success: true,
    decay,
    compression,
    archive,
    dream, 
    pruning, 
  };
}
