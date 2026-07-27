import { supabase } from "../db.js";

import {
    MemoryState
} from "../memory/types.js";


/**
 * OpenCNS Pruning Module v2
 *
 * archived → pruned
 *
 * Safety rules:
 *
 * 1. only archived memories
 * 2. importance < 0.1
 * 3. protected memory types excluded
 */


const PROTECTED_TYPES = [
    "identity",
    "goal",
    "preference",
    "relationship",
];



export async function runPruning() {


    const fromState:
    MemoryState =
    "archived";


    const toState:
    MemoryState =
    "pruned";



    const {
        data,
        error
    } =
    await supabase
        .from("memories")
        .select(
            "id, memory_type"
        )
        .eq(
            "memory_state",
            fromState
        )
        .lt(
            "importance",
            0.1
        )
        .limit(50);



    if(error){

        throw new Error(
            `Pruning query failed: ${error.message}`
        );

    }



    const ids =
    (data ?? [])
    .filter(
        item =>
        !PROTECTED_TYPES.includes(
            item.memory_type
        )
    )
    .map(
        item =>
        item.id
    );



    if(ids.length === 0){

        return {

            enabled:true,

            pruned:0,

            status:
            "no candidates"

        };

    }



    const {
        error:updateError
    }
    =
    await supabase
        .from("memories")
        .update({

            memory_state:
            toState

        })
        .in(
            "id",
            ids
        );



    if(updateError){

        throw new Error(
            `Pruning update failed: ${updateError.message}`
        );

    }



    return {

        enabled:true,

        pruned:
        ids.length,

        status:
        "completed"

    };

}



export const PruningModule = {

    run:
    runPruning,

};