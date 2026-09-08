import { MemoryModule } from "../memory/index.js";

import {
    runRouterPipeline
} from "./pipeline/runPipeline.js";

import {
    ConversationSummary
} from "../conversation/index.js";

const LONG_TERM_IMPORTANCE_THRESHOLD = 0.6;
/**
 * 旧版即时记忆入口
 *
 * Analyzer 现在返回 AnalysisResult[]
 * 因此这里逐条处理分析结果。
 */
export async function routeMemory(
    user: string,
    assistant: string,
) {

    const content =
`林遇：
${user}

江瑜：
${assistant}`;


    const analyses =
        await MemoryModule.analyze(
            content
        );


    const saved = [];

    for (const analysis of analyses) {

    if (!analysis.content.trim()) {

    saved.push({

        saved: false,

        reason:
        "empty-content",

        importance:
        analysis.importance,

        speaker:
        analysis.speaker,

        subject:
        analysis.subject,

    });

    continue;

  }

        if (
        analysis.importance <
        LONG_TERM_IMPORTANCE_THRESHOLD
      ) {

            saved.push({
                saved: false,
                reason: "low-importance",
                importance: analysis.importance,
                speaker: analysis.speaker,
                subject: analysis.subject,
            });

            continue;
        }


        const result =
            await MemoryModule.save({

                content: analysis.content,

                metadata: {

                    source: "router",

                    speaker: analysis.speaker,

                    subject: analysis.subject,

                    importance: analysis.importance,

                    memoryType: analysis.memory_type,

                    unresolved: analysis.unresolved,

                    valence: analysis.valence,

                    arousal: analysis.arousal,

                    keywords: analysis.keywords,

                }

            });


        saved.push({
            saved: true,
            speaker: analysis.speaker,
            subject: analysis.subject,
            result,
        });

    }


    return {
        saved: saved.some(
            item => item.saved === true
        ),
        results: saved,
    };

}


/**
 * 新版 Conversation → Memory
 */
export async function routeConversation(
    conversation: ConversationSummary
) {

    const pipeline =
        await runRouterPipeline(
            conversation
        );


    if (!pipeline.ok) {

        return {

            saved: false,

            reason:
            pipeline.reason

        };

    }


    const analyses =
        await MemoryModule.analyze(
            conversation.content
        );


    const saved = [];


    for (const analysis of analyses) {

       if (
         analysis.importance <
         LONG_TERM_IMPORTANCE_THRESHOLD
      ) {

            saved.push({

                saved: false,

                reason:
                "low-importance",

                importance:
                analysis.importance,

                speaker:
                analysis.speaker,

                subject:
                analysis.subject,

            });

            continue;

        }


        const result =
            await MemoryModule.save({

                content:
                analysis.content,

                metadata: {

                    source:
                    "conversation-router",

                    sessionId:
                    conversation.sessionId,

                    speaker:
                    analysis.speaker,

                    subject:
                    analysis.subject,

                    importance:
                    analysis.importance,

                    memoryType:
                    analysis.memory_type,

                    unresolved:
                    analysis.unresolved,

                    valence:
                    analysis.valence,

                    arousal:
                    analysis.arousal,

                    keywords:
                    analysis.keywords,

                }

            });


        saved.push({

            saved: true,

            speaker:
            analysis.speaker,

            subject:
            analysis.subject,

            result,

        });

    }


    return {

        saved:
        saved.some(
            item => item.saved === true
        ),

        results:
        saved,

    };

}


export const RouterModule = {

    memory:
    routeMemory,

    conversation:
    routeConversation,

};
