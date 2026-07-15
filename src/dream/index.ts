/**
 * OpenCNS Dream Review Module v1
 *
 * Reviews archived memories
 * and creates reflection memories.
 */


import { supabase } from "../db.js";
import { MemoryModule } from "../memory/index.js";


export async function runDreamReview() {


    const { data, error } =
        await supabase
            .from("memories")
            .select(
                "id, content, importance"
            )
            .eq(
                "memory_state",
                "archived"
            )
            .limit(20);



    if (error) {

        throw new Error(
            `Dream query failed: ${error.message}`
        );

    }



    const memories =
        data ?? [];



    if (
        memories.length === 0
    ) {

        return {

            enabled: true,

            reviewed: 0,

            status:
                "no archived memories"

        };

    }



    const reflection =
        `Dream Review Summary:\n` +
        memories
            .map(
                m =>
                `- ${m.content}`
            )
            .join("\n");



    const saved =
    await MemoryModule.save({

        content:
            reflection,

        metadata: {

            source:
                "dream-review",

            reviewed:
                memories.map(
                    m => m.id
                )

        }

    });


    const identitySaved =
    await MemoryModule.save({

        content:
            `Long-term identity reflection:\n${reflection}`,

        memory_type:
            "identity",

        metadata: {

            source:
                "identity-update",

            fromDream:
                true

        }

    });



    return {

        enabled: true,

        reviewed:
            memories.length,

        reflection:
            saved,

        identity:
            identitySaved,

        status:
            "completed"

    };

}



export const DreamModule = {

    run:
        runDreamReview,

};