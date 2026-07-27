import { MemoryModule } from "../memory/index.js";

import {
    runRouterPipeline
} from "./pipeline/runPipeline.js";

import {
    ConversationSummary
} from "../conversation/index.js";



/**
 * 旧版即时记忆入口
 *
 * 保留兼容
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



    const analysis =
        await MemoryModule.analyze(
            content
        );



    if(
        analysis.importance < 0.6
    ){

        return {

            saved:false,

            reason:
            "low-importance",

            importance:
            analysis.importance

        };

    }



    return await MemoryModule.save({

        content,

        metadata:{

            source:
            "router",

            importance:
            analysis.importance,

            memoryType:
            analysis.memory_type

        }

    });

}





/**
 * 新版 Conversation → Memory
 */
export async function routeConversation(
    conversation: ConversationSummary
){


    const pipeline =
        await runRouterPipeline(
            conversation
        );



    if(!pipeline.ok){

        return {

            saved:false,

            reason:
            pipeline.reason

        };

    }



    const analysis =
        await MemoryModule.analyze(
            conversation.content
        );



    if(
        analysis.importance < 0.6
    ){

        return {

            saved:false,

            reason:
            "low-importance",

            importance:
            analysis.importance

        };

    }



    return await MemoryModule.save({

        content:
        conversation.content,


        metadata:{

            source:
            "conversation-router",

            sessionId:
            conversation.sessionId,

            importance:
            analysis.importance,

            memoryType:
            analysis.memory_type

        }

    });

}




export const RouterModule = {


    memory:
    routeMemory,


    conversation:
    routeConversation,

};