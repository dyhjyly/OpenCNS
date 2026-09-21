import { runReflex } from "../reflex/index.js";
import {
    buildDynamicReflexContext
} from "../reflex/context/prompt.js";

import {
    buildStablePrompt
} from "../reflex/context/stablePrompt.js";

import {
    chat,
    ChatMessage
} from "../llm/index.js";

import {
    handleSaveMemory
} from "../memory/index.js";

import {
    routeMemory
} from "../router/index.js";

import {
    workingMemory
} from "../working-memory/index.js";

import {
    sessionManager
} from "../session/index.js";

import {
    conversationState
} from "../conversation/index.js";

import {
    readUploadedFile
} from "../files/reader.js";

import {
    runRecall
} from "../recall/index.js";


export interface ChatRequest {

    message: string;

    sessionId?: string;

    endSession?: boolean;

    images?: string[];

    files?: {
        name: string;
        type: string;
        data: string;
    }[];

}


export interface ChatResponse {

    reply: string;

    sessionId?: string;

}


export async function handleChat(
    request: ChatRequest
): Promise<ChatResponse> {

    console.log(
        "[CHAT ENTRY] message =",
        request.message
    );

    console.log(
        "[CHAT ENTRY] files =",
        request.files?.length ?? 0
    );

    console.log(
        "[CHAT ENTRY] file names =",
        request.files?.map(
            (f) => f.name
        )
    );


    let sessionId =
        request.sessionId;


    const chatStartedAt =
        Date.now();


    const chatTimer = (
        label: string,
        startedAt: number
    ) => {

        console.log(
            `[CHAT] ${label}:end +${Date.now() - startedAt}ms`
        );

    };


    /*
     * Session
     */

    if (!sessionId) {

        const session =
            await sessionManager.create();

        sessionId =
            session.id;

        await conversationState.create(
            sessionId
        );

    } else {

        await sessionManager.updateActive(
            sessionId
        );

        const existingConversationState =
            await conversationState.get(
                sessionId
            );

        if (!existingConversationState) {

            await conversationState.create(
                sessionId
            );

        }

    }


    /*
     * Reflex
     */

    const reflexStartedAt =
        Date.now();

    console.log(
        "[CHAT] reflex:start"
    );


    await conversationState.addMessage(
        sessionId,
        {
            id: crypto.randomUUID(),
            role: "user",
            content: request.message,
            createdAt: new Date().toISOString()
        }
    );


    const context =
        await runReflex(
            request.message
        );


    chatTimer(
        "reflex",
        reflexStartedAt
    );


    /*
     * Memory Recall
     *
     * Notice
     * ↓
     * Retrieval
     * ↓
     * Recall Agent
     */

    const recallStartedAt =
        Date.now();

    console.log(
        "[CHAT] recall:start"
    );


    const recallResult =
        await runRecall(
            request.message
        );


    chatTimer(
        "recall",
        recallStartedAt
    );


    console.log(
    "[CHAT] recall:selected =",
    recallResult.recalled.length
  );

    console.log(
    "[RECALL] selected:"
  );  

    recallResult.recalled.forEach(
      (item, index) => {
         console.log(
             `${index + 1}.`,
             item.content
         );
     }
 );


    /*
     * Recall Context
     */

    const recallContext =
        recallResult.recalled.length > 0
            ? recallResult.recalled
                .map(
                    item =>
                        `- ${item.content}`
                )
                .join("\n")
            : "";


    /*
     * Working Memory
     */

    const workingMemoryListStartedAt =
        Date.now();

    console.log(
        "[CHAT] working-memory:list:start"
    );


    const workingItems =
        await workingMemory.list();


    chatTimer(
        "working-memory:list",
        workingMemoryListStartedAt
    );


    const workingContext =
        workingItems.length > 0

            ? workingItems
                .slice(-10)
                .map(
                    item =>
                        `- ${item.role}: ${item.content}`
                )
                .join("\n")

            : "";


    /*
     * User Content
     */

    const userParts: any[] = [];


    if (request.message) {

        userParts.push({

            type: "text",

            text:
                request.message,

        });

    }


    if (
        request.images &&
        request.images.length > 0
    ) {

        for (
            const url of request.images
        ) {

            userParts.push({

                type: "image_url",

                image_url: {

                    url,

                },

            });

        }

    }


    if (
        request.files &&
        request.files.length > 0
    ) {

        console.log(
            "[FILES]",
            request.files.map(
                file => ({

                    name:
                        file.name,

                    type:
                        file.type,

                    dataLength:
                        file.data?.length,

                    dataPrefix:
                        file.data?.slice(
                            0,
                            30
                        ),

                })
            )
        );


        for (
            const file of request.files
        ) {

            const readable =
                await readUploadedFile(
                    file.name,
                    file.type,
                    file.data,
                );


            userParts.push({

                type: "text",

                text:
                    `用户上传了文件：${readable.name}\n` +
                    `文件类型：${readable.type}\n` +
                     `文件内容：\n${readable.text}`,

            });

        }

    }


    const userContent =
        userParts.length > 0

            ? userParts

            : request.message;


    console.log(
        "[FILES] userContent =",
        JSON.stringify(
            userContent,
            null,
            2
        ).slice(
            0,
            5000
        )
    );


    /*
     * LLM Context
     *
     * Reflex
     * +
     * Recall
     * +
     * Working Memory
     */

const stablePrompt =
    buildStablePrompt();

const dynamicContext =
    buildDynamicReflexContext(
        context
    );

const conversation =
    await conversationState.get(
        sessionId
    );

const rollingSummary =
    conversation?.rollingSummary ?? "";

const conversationPrompt =
    rollingSummary
        ? "\n\n" +
          "以下是当前对话此前已经形成的 Rolling Summary。" +
          "\n它用于保持当前会话的连续性。" +
          "\n只在相关时使用，不要逐条复述。" +
          "\n\n" +
          rollingSummary
        : "";

const recallPrompt =
    recallContext
        ? "\n\n" +
          "以下是本轮主动召回的长期记忆。" +
          "\n只在相关时自然使用，不要逐条复述。" +
          "\n\n" +
          recallContext
        : "";

const workingPrompt = "";

console.log(
    "[CONVERSATION] rolling-summary:length =",
    rollingSummary.length
);

console.log(
    "[CACHE SPLIT]",
    JSON.stringify({
        stable: stablePrompt.length,
        dynamic: dynamicContext.length,
        recall: recallPrompt.length,
        conversation: conversationPrompt.length,
        working: workingPrompt.length,
        total:
            stablePrompt.length +
            dynamicContext.length +
            conversationPrompt.length +
            recallPrompt.length +
            workingPrompt.length
    })
);

const messages: ChatMessage[] = [

    {
        role: "system",
        content:
            stablePrompt
    },

    {
        role: "user",
        content:
            dynamicContext +
            conversationPrompt +
            recallPrompt +
            workingPrompt +
            "\n\n当前用户消息：\n" +
            (
                typeof userContent === "string"
                    ? userContent
                    : JSON.stringify(userContent)
            )
    }

];
    
        console.log(
        "[CACHE TEST] systemPromptLength =",
        typeof messages[0].content === "string"
            ? messages[0].content.length
            : 0
    );

    /*
     * Main LLM
     */

    const llmStartedAt =
        Date.now();


    console.log(
        "[CHAT] llm:start"
    );


    const response =
        await chat({

            messages

        });


    chatTimer(
        "llm",
        llmStartedAt
    );


    /*
     * Working Memory
     *
     * 先保存当前对话。
     */

    const addUserStartedAt =
        Date.now();


    console.log(
        "[CHAT] working-memory:add-user:start"
    );


    await workingMemory.add({

        id:
            crypto.randomUUID(),

        role:
            "user",

        displayName:
            "林遇",

        content:
            request.message,

        createdAt:
            new Date().toISOString(),

        sessionId,

    });


    chatTimer(
        "working-memory:add-user",
        addUserStartedAt
    );


    const addAssistantStartedAt =
        Date.now();


    console.log(
        "[CHAT] working-memory:add-assistant:start"
    );


    await conversationState.addMessage(
        sessionId,
        {
            id: crypto.randomUUID(),
            role: "assistant",
            content: response.content,
            createdAt: new Date().toISOString()
        }
    );

    void conversationState.compressIfNeeded(sessionId)
        .then(() => {
        console.log("[CONVERSATION] rolling-summary:check:end");
    })
        .catch(error => {
        console.error("[CONVERSATION] rolling-summary:check:error", error);
    });

    await workingMemory.add({

        id:
            crypto.randomUUID(),

        role:
            "assistant",

        displayName:
            "江瑜",

        content:
            response.content,

        createdAt:
            new Date().toISOString(),

        sessionId,

    });


    chatTimer(
        "working-memory:add-assistant",
        addAssistantStartedAt
    );


    /*
     * Return
     *
     * 到这里就已经完成：
     *
     * Reflex
     * Recall
     * LLM
     * Working Memory
     *
     * Router 不再阻塞用户回复。
     */

    console.log(
        "[CHAT] handler:return:start"
    );


    const result: ChatResponse = {

        reply:
            response.content,

        sessionId,

    };


    console.log(
        "[CHAT] handler:return:end"
    );


    console.log(
        `[CHAT] TOTAL: ${Date.now() - chatStartedAt}ms`
    );


    /*
 * Router / Session
 *
 * 普通聊天：
 * 后台执行旧版 Router。
 *
 * endSession：
 * 先结束 Session，
 * 再通过 Conversation Summary → Router V2
 * 进入长期记忆流程。
 */

if (request.endSession) {

    console.log(
        "[CHAT] session:close:start"
    );

    void sessionManager
        .closeAndStore(sessionId)
        .then(
            sessionResult => {

                console.log(
                    "[CHAT] session:close:end"
                );

                console.log(
                    "SESSION CLOSE RESULT:",
                    JSON.stringify(
                        sessionResult,
                        null,
                        2
                    )
                );

            }
        )
        .catch(
            error => {

                console.error(
                    "[CHAT] session:close:error",
                    error
                );

            }
        );

} else {

    void routeMemory(
        request.message,
        response.content
    )
        .then(
            memoryResult => {

                console.log(
                    "[CHAT] router:background:end"
                );

                console.log(
                    "ROUTER RESULT:",
                    JSON.stringify(
                        memoryResult,
                        null,
                        2
                    )
                );

            }
        )
        .catch(
            error => {

                console.error(
                    "[CHAT] router:background:error",
                    error
                );

            }
        );

}


    return result;

}