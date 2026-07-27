import { runReflex } from "../reflex/index.js";
import {
    buildReflexPrompt
} from "../reflex/context/prompt.js";
import {
    chat,
    ChatMessage
} from "../llm/index.js";

import {
    handleSaveMemory,
    handleSearchMemories
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


export interface ChatRequest {

    message: string;

    sessionId?: string;

}


export interface ChatResponse {

    reply: string;

    sessionId?: string;

}


export async function handleChat(
    request: ChatRequest
): Promise<ChatResponse> {


    let sessionId =
        request.sessionId;


    if(!sessionId){

        const session =
        await sessionManager.create();


        sessionId =
        session.id;

    }
    else{

        await sessionManager.updateActive(
            sessionId
        );

    }


    const context = await runReflex(
        request.message
    );


    // 搜索长期记忆
    const memories = await handleSearchMemories({
        query: request.message,
    });


    const memoryContext = Array.isArray(memories)
        ? memories
            .map((m: { content?: string }) => `- ${m.content ?? ""}`)
            .join("\n")
        : "";

    const workingItems =
    await workingMemory.list();


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

    const messages: ChatMessage[] = [
        {
            role: "system",
            content:
             buildReflexPrompt(context)
              +
              (
               memoryContext
                 ? "\n\n以下是相关长期记忆，请自然利用，不要逐条复述。\n\n"
                  + memoryContext
                 : ""
              )
             +
             (
               workingContext
                  ? "\n\n以下是当前短期工作记忆，只用于理解当前对话，不要保存为长期记忆。\n\n"
                 + workingContext
                  : ""
             )
        },
        {
            role: "user",
            content: request.message
        }
    ];


    const response = await chat({
    messages
  });


    const memoryResult = await routeMemory(
    request.message,
    response.content
   );  

   console.log(
      "ROUTER RESULT:",
      JSON.stringify(memoryResult, null, 2)
  );

    await workingMemory.add({
    id: crypto.randomUUID(),
    role: "user",
    displayName: "林遇",
    content: request.message,
    createdAt: new Date().toISOString(),
    sessionId,
});

    await workingMemory.add({
    id: crypto.randomUUID(),
    role: "assistant",
    displayName: "江瑜",
    content: response.content,
    createdAt: new Date().toISOString(),
    sessionId,
});

   return {
    reply: response.content,
    sessionId,
};
 
}
