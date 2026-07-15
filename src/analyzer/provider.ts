import dotenv from 'dotenv';
import { getCognitiveProvider } from "../llm/provider.js";
import type { ChatMessage } from "../llm/types.js";
import { ANALYZER_PROMPT } from './prompt.js';

dotenv.config();

const API_KEY = process.env.DEEPSEEK_API_KEY;

export async function callAnalyzer(content: string) {

    const provider = getCognitiveProvider();

    const messages: ChatMessage[] = [
        {
            role: "system",
            content: ANALYZER_PROMPT,
        },
        {
            role: "user",
            content,
        },
    ];

    return provider.chat({
    model:
        process.env.LLM_ANALYZER_MODEL ||
        process.env.COGNITIVE_MODEL,
    messages,
    });
}