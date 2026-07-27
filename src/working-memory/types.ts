export interface WorkingMemoryItem {

    id: string;

    role:
    | "user"
    | "assistant";

    displayName?: string;

    content: string;

    createdAt: string;

    sessionId?: string;

}


export interface WorkingMemoryStore {

    add(
        item: WorkingMemoryItem
    ): Promise<void>;


    list(
        sessionId?: string
    ): Promise<WorkingMemoryItem[]>;


    clear(
        sessionId?: string
    ): Promise<void>;

}
