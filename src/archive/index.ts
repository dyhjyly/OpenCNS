import { supabase } from "../db.js";

import {
    MemoryState
} from "../memory/types.js";


/**
 * OpenCNS Archive Module v2
 *
 * compressed → archived
 */


export async function runArchive() {


    const fromState:
    MemoryState =
    "compressed";


    const toState:
    MemoryState =
    "archived";



    const { data, error } =
        await supabase
            .from("memories")
            .select("id")
            .eq(
                "memory_state",
                fromState
            )
            .limit(50);



    if(error){

        throw new Error(
            `Archive query failed: ${error.message}`
        );

    }



    const ids =
    (data ?? [])
    .map(
        item => item.id
    );



    if(ids.length === 0){

        return {

            enabled:true,

            archived:0,

            status:
            "no candidates"

        };

    }



    const {
        error:updateError
    } =
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
            `Archive update failed: ${updateError.message}`
        );

    }



    return {

        enabled:true,

        archived:
        ids.length,

        status:
        "completed"

    };

}