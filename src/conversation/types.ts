import { WorkingMemoryItem } from "../working-memory/index.js";


export interface ConversationSummary {

    id: string;

    sessionId: string;

    content: string;

    sourceItems: WorkingMemoryItem[];

    createdAt: string;

}