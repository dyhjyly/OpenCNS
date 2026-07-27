import { WorkingMemoryItem } from "../working-memory/index.js";
import { ConversationSummary } from "./types.js";


export async function summarizeConversation(
    items: WorkingMemoryItem[],
    sessionId: string
): Promise<ConversationSummary> {


    const content =
        items
        .map(item => {

            const name =
                item.displayName ??
                (
                    item.role === "user"
                    ? "林遇"
                    : "江瑜"
                );


            return `${name}：${item.content}`;

        })
        .join("\n\n");



    return {

        id:
        crypto.randomUUID(),

        sessionId,

        content,

        sourceItems:
        items,

        createdAt:
        new Date().toISOString()

    };

}