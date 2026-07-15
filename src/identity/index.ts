/**
 * OpenCNS Identity Module v1
 *
 * Maintains long-term system identity.
 */


import { supabase } from "../db.js";


export async function runIdentity() {


    const { data, error } =
        await supabase
            .from("memories")
            .select(
                "content, created_at"
            )
            .eq(
                "memory_type",
                "identity"
            )
            .order(
                "created_at",
                {
                    ascending: false
                }
            )
            .limit(20);



    if (error) {

        throw new Error(
            `Identity query failed: ${error.message}`
        );

    }



    const memories =
        data ?? [];



    if (
        memories.length === 0
    ) {

        return {

            enabled: true,

            summary:
                "",

            updated:
                false,

            status:
                "no identity memories"

        };

    }



    const summary =
        memories
            .map(
                item =>
                    item.content
            )
            .join(
                "\n"
            );



    return {

        enabled: true,

        summary,

        updated:
            false,

        status:
            "loaded"

    };

}



export const IdentityModule = {

    run:
        runIdentity,

};