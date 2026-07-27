import { isMemoryCandidate } from "../filters/isMemoryCandidate.js";
import { isLongTermMemory } from "../filters/isLongTermMemory.js";

import {
    ConversationSummary
} from "../../conversation/index.js";


export async function runRouterPipeline(
    conversation: ConversationSummary
) {


    const text =
        conversation.content;



    const candidate =
        isMemoryCandidate(text);



    if (!candidate.ok) {

        return {

            ok:false,

            reason:
            candidate.reason,

        };

    }



    const longTerm =
        isLongTermMemory(text);



    if (!longTerm.ok) {

        return {

            ok:false,

            reason:
            longTerm.reason,

        };

    }



    return {

        ok:true,

        conversation,

    };

}