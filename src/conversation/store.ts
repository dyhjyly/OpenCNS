import {
    supabase
} from "../db.js";

import {
    ConversationMessage
} from "./state.js";


export interface ConversationSummaryRecord {

    sessionId: string;

    summary: string;

    summarizedThrough:
        string | null;

    createdAt: string;

    updatedAt: string;

}


export async function loadConversationSummary(
    sessionId: string
): Promise<ConversationSummaryRecord | null> {

    const {
        data,
        error
    } = await supabase
        .from("conversation_summaries")
        .select(
          "session_id, summary, summarized_through, created_at, updated_at"
        )
        .eq(
            "session_id",
            sessionId
        )
        .maybeSingle();


    if (error) {

        throw error;

    }


    if (!data) {

        return null;

    }


    return {

        sessionId:
            data.session_id,

        summary:
            data.summary,

        summarizedThrough:
            data.summarized_through,

        createdAt:
            data.created_at,

        updatedAt:
            data.updated_at

    };

}


export async function saveConversationSummary(
    sessionId: string,
    summary: string,
    summarizedThrough: string | null
): Promise<void> {

    const {
        error
    } = await supabase
        .from("conversation_summaries")
        .upsert(
            {
                session_id:
                    sessionId,

                summary,

                summarized_through:
                    summarizedThrough,

                updated_at:
                    new Date().toISOString()

            },
            {
                onConflict:
                    "session_id"
            }
        );


    if (error) {

        throw error;

    }

}


export async function loadRecentMessages(
    sessionId: string
): Promise<ConversationMessage[]> {
    console.log(
        "[CONVERSATION STORE] loadRecentMessages:start",
        sessionId
    );

    try {
        const query = supabase
            .from("recent_chat")
            .select("id, role, content, created_at")
            .eq("session_id", sessionId)
            .order("sequence", { ascending: false })
            .limit(60);

        const timeout = new Promise<never>((_, reject) => {
            setTimeout(() => {
                reject(new Error("recent_chat query timed out after 10 seconds"));
            }, 10000);
        });

        const { data, error } = await Promise.race([
            query,
            timeout
        ]);

        if (error) {
            console.error(
                "[CONVERSATION STORE] loadRecentMessages:db-error",
                error
            );
            throw error;
        }

        const messages = (data ?? []).reverse().map(row => ({
            id: row.id,
            role: row.role,
            content: row.content,
            createdAt: row.created_at
        }));

        console.log(
            "[CONVERSATION STORE] loadRecentMessages:success",
            { sessionId, count: messages.length }
        );

        return messages;
    } catch (error) {
        console.error(
            "[CONVERSATION STORE] loadRecentMessages:failed",
            error
        );
        throw error;
    }
}


export async function saveRecentMessage(
    sessionId: string,
    message: ConversationMessage,
    sequence: number
): Promise<void> {

    const {
        error
    } = await supabase
        .from("recent_chat")
        .insert(
            {

                id:
                    message.id,

                session_id:
                    sessionId,

                sequence,

                role:
                    message.role,

                content:
                    message.content,

                created_at:
                    message.createdAt

            }
        );


    if (error) {

        throw error;

    }

}


export async function trimRecentMessages(
    sessionId: string
): Promise<void> {

    const {
        data,
        error
    } = await supabase
        .from("recent_chat")
        .select(
            "id"
        )
        .eq(
            "session_id",
            sessionId
        )
        .order(
            "sequence",
            {
                ascending: false
            }
        )
        .range(
            60,
            10000
        );


    if (error) {

        throw error;

    }


    const ids =
        (data ?? [])
            .map(
                row => row.id
            );


    if (
        ids.length === 0
    ) {

        return;

    }


    const {
        error:
            deleteError
    } = await supabase
        .from("recent_chat")
        .delete()
        .in(
            "id",
            ids
        );


    if (deleteError) {

        throw deleteError;

    }

}
