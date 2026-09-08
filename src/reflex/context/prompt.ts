import {
    ReflexContext
} from "./index.js";


export function buildDynamicReflexContext(
    context: ReflexContext
): string {

    const memories =
        context.memory
            .map(
                item => "- " + item.content
            )
            .join("\n");

    const graph =
        context.graph
            .map(
                item => "- " + item.content
            )
            .join("\n");

    const beliefs =
        context.belief
            .map(
                item => "- " + item.content
            )
            .join("\n");

    const curiosity =
        context.curiosity
            .map(
                item => "- " + item.content
            )
            .join("\n");


    console.log(
        "[DYNAMIC SPLIT]",
        JSON.stringify({
            memory: memories.length,
            graph: graph.length,
            belief: beliefs.length,
            curiosity: curiosity.length,
            total:
                memories.length +
                graph.length +
                beliefs.length +
                curiosity.length
        })
    );


    return `
========================
动态认知上下文
========================

长期记忆：

${memories || "暂无相关长期记忆。"}

认知图谱：

${graph || "暂无图谱信息。"}

信念：

${beliefs || "暂无信念信息。"}

好奇心：

${curiosity || "暂无主动探索目标。"}
`;

}