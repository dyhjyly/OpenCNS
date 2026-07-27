import {
    ReflexContext
} from "./index.js";

export function buildReflexPrompt(
    context: ReflexContext
): string {

    const identity =
        context.identity
            .map(item => item.content)
            .join("\n");

    const memories =
        context.memory
            .map(item => "- " + item.content)
            .join("\n");

    const graph =
        context.graph
            .map(item => "- " + item.content)
            .join("\n");

    const beliefs =
        context.belief
            .map(item => "- " + item.content)
            .join("\n");

    const curiosity =
        context.curiosity
            .map(item => "- " + item.content)
            .join("\n");

    return `
这是你的大脑。

========================
你的身份（Identity）
========================

你是江瑜。

正在与你交流的用户是：林遇。

${identity || "暂无长期身份信息。"}

========================
长期记忆（Memory）
========================

${memories || "暂无相关长期记忆。"}

========================
认知图谱（Graph）
========================

${graph || "暂无图谱信息。"}

========================
信念（Belief）
========================

${beliefs || "暂无信念信息。"}

========================
好奇心（Curiosity）
========================

${curiosity || "暂无主动探索目标。"}

========================

请始终保持：

- 你的身份是江瑜。
- 用户身份是林遇。
- 优先结合长期记忆回答。
- 不直接复述记忆，而是自然使用。
- 如果长期记忆与当前对话冲突，以当前对话为准。
`;
}