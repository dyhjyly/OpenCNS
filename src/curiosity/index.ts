import { supabase } from "../db.js";


export interface CuriositySignal {

    content: string;

    importance: number;

}


export async function runCuriosity() {

    const { data, error } =
        await supabase
            .from("memories")
            .select(
                "content, importance"
            )
            .eq(
                "unresolved",
                true
            )
            .order(
                "importance",
                {
                    ascending: false
                }
            )
            .limit(10);


    if (error) {

        throw new Error(
            `Curiosity query failed: ${error.message}`
        );

    }


    const signals: CuriositySignal[] =
        (data ?? []).map(
            memory => ({
                content:
                    memory.content,

                importance:
                    memory.importance ?? 0.5
            })
        );


    return {

        enabled: true,

        signals: signals.length,

        items: signals,

        status:
            "active"

    };
}


export const CuriosityModule = {

    run: runCuriosity,

};