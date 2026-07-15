/**
 * OpenCNS Archive Module v1
 *
 * Move compressed memories into long-term archive.
 */


import { supabase } from "../db.js";


export async function runArchive() {


    const { data, error } =
        await supabase
            .from("memories")
            .select(
                "id"
            )
            .eq(
                "memory_state",
                "compressed"
            )
            .limit(50);



    if (error) {

        throw new Error(
            `Archive query failed: ${error.message}`
        );

    }



    const ids =
        (data ?? [])
        .map(
            item => item.id
        );



    if (
        ids.length === 0
    ) {

        return {

            enabled: true,

            archived: 0,

            status:
                "no candidates"

        };

    }



    const { error: updateError } =
        await supabase
            .from("memories")
            .update({

                memory_state:
                    "archived"

            })
            .in(
                "id",
                ids
            );



    if (updateError) {

        throw new Error(
            `Archive update failed: ${updateError.message}`
        );

    }



    return {

        enabled: true,

        archived:
            ids.length,

        status:
            "completed"

    };

}