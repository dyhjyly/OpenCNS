import {
    ReflexContext
} from "./index.js";


export function buildReflexPrompt(
    context: ReflexContext
): string {

    return `
你正在使用 OpenCNS 认知系统。

以下是用户相关的上下文记忆。
只在相关时参考，不要主动提及记忆来源。

${JSON.stringify(
    context,
    null,
    2
)}

请结合以上信息回答用户。
`;
}
