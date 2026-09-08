import { isMemoryCandidate } from "../filters/isMemoryCandidate.js";
import {
    ConversationSummary
} from "../../conversation/index.js";


export interface RouterPipelineResult {

    ok: boolean;

    reason?: string;

    conversation?: ConversationSummary;

    candidate?: {

        text: string;

        eligible: boolean;

    };

}


/**
 * Router Pipeline
 *
 * 当前阶段：
 *
 * Conversation
 *      ↓
 * Candidate Filter
 *      ↓
 * eligible / rejected
 *
 * 后续阶段会继续扩展为：
 *
 * Notice
 *      ↓
 * Retrieval
 *      ↓
 * Recall Agent
 *      ↓
 * Context Assembly
 *
 * 注意：
 * 当前 Pipeline 不负责真正的 Memory Recall。
 * 它只负责判断这段 conversation 是否值得进入后续认知流程。
 */
export async function runRouterPipeline(
    conversation: ConversationSummary
): Promise<RouterPipelineResult> {

    const text =
        conversation.content?.trim() ?? "";


    /*
     * 空 conversation 直接拒绝
     */
    if (!text) {

        return {

            ok: false,

            reason: "empty-conversation",

        };

    }


    /*
     * 第一阶段：
     * 判断这段 conversation 是否具备长期记忆候选资格。
     */
    const candidate =
        isMemoryCandidate(text);


    if (!candidate.ok) {

        return {

            ok: false,

            reason: candidate.reason,

        };

    }


    /*
     * 进入后续 Router Pipeline。
     *
     * 当前先不执行 Recall / Agent。
     */
    return {

        ok: true,

        conversation,

        candidate: {

            text,

            eligible: true,

        },

    };

}