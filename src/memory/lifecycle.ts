import { CompressionModule } from "../compression/index.js";
import { DreamModule } from "../dream/index.js";
import { PruningModule } from "../pruning/index.js";

import { runMemoryDecay } from "./decayEngine.js";
import { runMemoryArchive } from "./archive.js";



async function runStage(
  name:string,
  task:()=>Promise<any>
){

  const start =
    Date.now();


  try{

    const result =
      await task();


    return {

      stage:name,

      success:true,

      duration:
        Date.now() - start,

      result,

    };


  }catch(error:any){


    return {

      stage:name,

      success:false,

      duration:
        Date.now() - start,

      error:
        error?.message ??
        "unknown error",

    };

  }

}




/**
 * 🧠 OpenCNS Memory Lifecycle v2
 *
 * Decay
 * Compression
 * Archive
 * Dream
 * Pruning
 */

export async function runLifecycle(){


  const stages = [];



  stages.push(
    await runStage(
      "decay",
      () =>
        runMemoryDecay(50)
    )
  );



  stages.push(
    await runStage(
      "compression",
      () =>
        CompressionModule.run()
    )
  );



  stages.push(
    await runStage(
      "archive",
      () =>
        runMemoryArchive(0.2)
    )
  );



  stages.push(
    await runStage(
      "dream",
      () =>
        DreamModule.run()
    )
  );



  stages.push(
    await runStage(
      "pruning",
      () =>
        PruningModule.run()
    )
  );



  return {

    success:
      stages.every(
        stage =>
        stage.success
      ),

    stages,

  };

}