/**
 * OpenCNS Identity Module v2
 *
 * Maintains long-term system identity.
 *
 * Identity is generated from
 * protected identity memories.
 */


import { supabase } from "../db.js";
import {
    updateIdentityState
} from "./state.js";


export async function runIdentity() {


    const {
        data,
        error
    }
    =
    await supabase
        .from("memories")
        .select(
            "content, created_at, importance"
        )
        .eq(
            "memory_type",
            "identity"
        )
        .neq(
            "memory_state",
            "pruned"
        )
        .order(
            "importance",
            {
                ascending:false
            }
        )
        .limit(20);



    if(error){

        throw new Error(
            `Identity query failed: ${error.message}`
        );

    }



    const memories =
        data ?? [];



    if(memories.length === 0){

        return {

            enabled:true,

            identity:"",

            memoryCount:0,

            updated:false,

            status:
            "no identity memories"

        };

    }



    const identity =
        memories
        .map(
            item =>
            item.content
        )
        .join(
            "\n\n"
        );



    const state =
updateIdentityState({

    identity,

    memoryCount:
        memories.length,

    updatedAt:
        new Date().toISOString(),

});


return {

    enabled:true,

    identity:
        state.identity,

    memoryCount:
        state.memoryCount,

    updatedAt:
        state.updatedAt,

    updated:true,

    status:
        "updated"

};

}



export const IdentityModule = {

    run:
        runIdentity,

};