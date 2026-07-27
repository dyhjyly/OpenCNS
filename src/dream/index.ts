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
      (data ?? []).filter((m) => {
      const text = (m.content ?? "").trim();

    // 空内容
    if (!text) return false;

    // 太短
    if (text.length < 12) return false;

    // 测试文本
    if (/测试|test|hello/i.test(text)) return false;

    // Dream 自己产生的总结
    if (text.startsWith("Dream Review Summary")) return false;

    // 身份反思
    if (text.startsWith("Long-term identity reflection")) return false;

    return true;
  });



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

// 去重，避免重复内容
     const uniqueContents = [
        ...new Set(memories.map((m) => m.content.trim())),
     ];

     if (uniqueContents.length === 0) {
     return {
      enabled: true,
      reviewed: 0,
      status: "nothing to review",
    };
   }

    const reflection =
       "Dream Review Summary:\n" +
        uniqueContents
       .map((text) => `- ${text}`)
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