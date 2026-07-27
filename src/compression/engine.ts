import { supabase } from "../db.js";

import {
    MemoryState
} from "../memory/types.js";


/**
 * Compression Engine v2
 *
 * active → compressed candidate
 */


export async function findCompressionCandidates(
    limit = 20
) {


    const activeState:
    MemoryState =
    "active";



    const { data, error } =
    await supabase
    .from("memories")
    .select(`
      id,
      content,
      importance,
      memory_state,
      created_at
    `)
    .eq(
        "memory_state",
        activeState
    )
    .lt(
        "importance",
        0.4
    )
    .limit(limit);



    if(error){

        throw new Error(
            `Compression query failed: ${error.message}`
        );

    }



    const candidates =
    data ?? [];



    if(candidates.length < 2){

        return [];

    }



    return [

        {

            group:
            "default",

            memories:
            candidates.map(
                item => ({

                    ...item,

                    memory_state:
                    item.memory_state as MemoryState

                })
            )

        }

    ];

}