import {
    ConversationSummaryInput
} from "./summary.js";

import {
    ChatMessage
} from "../llm/types.js";

import {
    getCognitiveProvider
} from "../llm/provider.js";


export async function generateRollingSummary(
    input: ConversationSummaryInput
): Promise<string> {

    const previousSummary =
        input.existingSummary.trim();


    const conversation =
        input.messages
            .map(
                message =>
                    `${message.role}: ${message.content}`
            )
            .join("\n");


    const messages: ChatMessage[] = [

        {
            role: "system",

            content:
                [
                    "你负责维护当前对话的 Rolling Summary。",
                    "",
                    "这是 Conversation Context 的摘要，不是长期记忆。",
                    "不要把摘要写成独立的长期记忆。",
                    "不要加入对话中不存在的信息。",
                    "不要编造用户的身份、偏好、目标或事实。",
                    "",
                    "保留当前对话连续性真正需要的信息，包括：",
                    "- 正在讨论的主题",
                    "- 已做出的决定",
                    "- 尚未解决的问题",
                    "- 重要的上下文",
                    "- 当前任务进展",
                    "- 对后续对话有用的承诺或约定",
                    "",
                    "删除重复、寒暄、无关细节和已经失去作用的信息。",
                    "如果存在旧 Rolling Summary，请在其基础上更新，而不是简单重复。",
                    "只输出更新后的 Rolling Summary。",
                ].join("\n")
        },

        {
            role: "user",

            content:
                [
                    "【已有 Rolling Summary】",

                    previousSummary ||
                        "（暂无，这是第一次生成摘要。）",

                    "",

                    "【较早的对话消息】",

                    conversation
                ].join("\n")
        }

    ];


    const provider =
        getCognitiveProvider();


    const result =
        await provider.chat({

            model:
                process.env.LLM_MEMORY_MODEL ||
                process.env.COGNITIVE_MODEL,

            messages

        });


    return result.content.trim();

}
