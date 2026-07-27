import { MemoryModule } from "../memory/index.js";
import { ReflexModule } from "../reflex/index.js";

/**
 * OpenCNS Scheduler v2 (Reflex-driven loop)
 *
 * Development mode:
 *  - Reflex enabled
 *  - Memory lifecycle disabled
 *
 * Production mode:
 *  - Full cognitive lifecycle enabled
 */

export async function runScheduler() {

  const cycles = [];

  let i = 0;


  const enableMemoryLifecycle =
    process.env.OPEN_CNS_LIFECYCLE === "true";


  while (true) {


    let memory:any = {
       enabled:false,
       status:"disabled"
      };


    if(enableMemoryLifecycle){

      memory =
        await MemoryModule.lifecycle();

    }


    const reflex =
      await ReflexModule.run();


    cycles.push({

      cycle:i,

      memory,

      reflex,

    });


    i++;


    if(
      reflex.decision === "stop"
      ||
      i >= 3
    ){

      break;

    }

  }


  return {

    running:true,

    mode:
      "reflex-loop-v2",

    lifecycle:
      enableMemoryLifecycle,

    cycles,

  };

}