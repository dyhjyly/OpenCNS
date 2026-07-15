import {
    getCognitiveProvider
} from "../llm/provider.js";
import dotenv from "dotenv";
    dotenv.config();
import {
    ChatMessage
} from "../llm/types.js";

export async function generateCompressionSummary(
    memories: {
        content: string;
    }[]
) {

    const provider =
        getCognitiveProvider();

    const text =
        memories
            .map(
                m => `- ${m.content}`
            )
            .join("\n");

    const messages: ChatMessage[] = [

        {
            role: "system",
            content:
                "请把下面多条记忆压缩成一段长期记忆，不要丢失重要事实，只输出总结。"
        },

        {
            role: "user",
            content: text
        }

    ];

    const result = await provider.chat({
        model:
            process.env.LLM_MEMORY_MODEL ||
            process.env.COGNITIVE_MODEL,
        messages
    });

    return result.content;
}