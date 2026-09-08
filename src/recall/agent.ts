import {
    getCognitiveProvider
} from "../llm/provider.js";

import type {
    ChatMessage
} from "../llm/types.js";

import type {
    RecallCandidate
} from "./retrieval.js";


export interface RecallResult {

    selectedIds: string[];

}


const RECALL_PROMPT = `
你是 OpenCNS 的 Memory Recall Agent。

你的唯一任务：

根据“当前用户消息”的实际意图，
从候选长期记忆中选择真正有帮助的记忆。

你不是在判断“哪些记忆看起来相似”，
而是在判断：

“如果把这条记忆提供给正在回答当前用户消息的模型，
它是否真的能够帮助模型更准确地理解、回答或回应用户？”

必须严格遵守以下规则：

1. 先理解当前用户消息真正想问什么。
2. 再判断候选记忆是否直接帮助回答这个问题。
3. 语义相似不等于相关。
4. similarity 高不代表必须选择。
5. importance 高不代表必须选择。
6. 不要为了凑数量而选择。
7. 可以一个都不选。
8. 最多选择 5 条。
9. 只选择真正相关的记忆。
10. 如果当前消息是明确询问过去的事情、过去的决定、过去的规则、过去的约定、过去的经历或过去的信息，应优先选择能够直接回答该询问的记忆。
11. 如果当前消息询问某个项目、设计、技术决定或开发原则，应优先选择该项目、设计、技术决定或开发原则本身的记忆。
12. 不要因为一条记忆中出现相同的人名、项目名或关键词，就认为它相关。
13. 不要选择仅仅描述“江瑜如何思考、如何运作、如何调用记忆”的元认知记忆，除非用户明确询问这些内容。
14. 不要选择与当前问题主题不同、但只是人物或项目名称相同的记忆。
15. 对于“我们之前关于 X 的决定是什么”这一类问题，应选择描述 X 的具体决定、原则、约定或目标的记忆，而不是选择描述系统自身运行机制的记忆。
16. 对于“你还记得 X 吗”这一类问题，应选择能够直接证明或解释 X 的历史记忆。
17. 对于普通闲聊，如果候选记忆不能自然帮助当前回应，可以全部不选。
18. 选择应该以“对当前回答是否有实际帮助”为最终标准。

特别注意：

如果用户问：

“我们之前关于 OpenCNS 记忆系统的设计决定是什么？”

那么：

“OpenCNS 一次只改一个地方、测试通过再继续”
“OpenCNS 保持模块独立”
“OpenCNS 做成模块化、可以长期运行的认知系统”

这类记忆属于直接相关。

而：

“江瑜回应前先建立身份框架，再调用记忆，再结合上下文”

属于 OpenCNS 的认知运作描述。
除非用户明确询问“江瑜如何运作”或“OpenCNS 如何生成回应”，否则不应该因为它包含 OpenCNS 或记忆相关概念而选择它。

再次强调：

判断标准不是：

“这条记忆和用户消息像不像？”

而是：

“这条记忆能不能直接帮助回答用户现在真正问的问题？”

只返回 JSON，不要输出任何解释：

{
  "selectedIds": ["id1", "id2"]
}

没有真正相关的记忆：

{
  "selectedIds": []
}
`;


export async function recall(
    query: string,
    candidates: RecallCandidate[]
): Promise<RecallResult> {

    if (candidates.length === 0) {
        return {
            selectedIds: [],
        };
    }

    const provider =
        getCognitiveProvider();

    const messages: ChatMessage[] = [

        {
            role: "system",
            content: RECALL_PROMPT,
        },

        {
            role: "user",
            content:
                `当前用户消息：

${query}

候选长期记忆：

${JSON.stringify(
    candidates,
    null,
    2
)}

请严格根据当前用户消息的实际意图，
选择真正能够帮助回答该消息的候选记忆。

只返回 JSON。
`,
        },

    ];

    const response =
        await provider.chat({

            model:
                process.env.LLM_MEMORY_MODEL ||
                process.env.COGNITIVE_MODEL,

            messages,

        });

    try {

        const parsed =
            JSON.parse(response.content);

        const candidateIds =
            new Set(
                candidates.map(
                    candidate =>
                        candidate.id
                )
            );

        const selectedIds =
            Array.isArray(
                parsed.selectedIds
            )
                ? parsed.selectedIds
                    .filter(
                        (id: unknown): id is string =>
                            typeof id === "string" &&
                            candidateIds.has(id)
                    )
                    .slice(0, 5)
                : [];

        return {
            selectedIds,
        };

    } catch {

        console.error(
            "[RECALL] invalid agent response:",
            response.content
        );

        return {
            selectedIds: [],
        };
    }
}