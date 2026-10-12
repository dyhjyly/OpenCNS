import { handleSearchMemories } from "../memory/index.js";
import { supabase } from "../db.js";

export interface RecallCandidate {
    id: string;
    content: string;
    memory_type?: string;
    importance?: number;
    unresolved?: boolean;
    similarity?: number;
    created_at?: string;
}


/**
 * Normalize memory content for duplicate detection.
 *
 * This does not modify the original memory.
 * It is only used for duplicate detection.
 */
function normalizeContent(
    content: string
): string {

    return content
        .replace(/\s+/g, "")
        .trim()
        .toLowerCase();
}


/**
 * Remove duplicated memories.
 *
 * Only handles:
 * 1. Exactly identical normalized content
 * 2. One normalized content fully contains the other
 *
 * Does not delete anything from the database.
 */
function deduplicateCandidates(
    candidates: RecallCandidate[]
): RecallCandidate[] {

    const result: RecallCandidate[] = [];

    for (const candidate of candidates) {

        const current =
            normalizeContent(
                candidate.content
            );

        if (!current) {
            continue;
        }

        const duplicate =
            result.some(existing => {

                const previous =
                    normalizeContent(
                        existing.content
                    );

                if (!previous) {
                    return false;
                }

                return (
                    previous === current ||
                    previous.includes(current) ||
                    current.includes(previous)
                );
            });

        if (!duplicate) {
            result.push(candidate);
        }
    }

    return result;
}


export async function retrieveCandidates(
    query: string
): Promise<RecallCandidate[]> {

    const result =
        await handleSearchMemories({
            query,
            limit: 10,
        });

    const text =
        result?.content?.[0]?.text;

    if (!text) {
        return [];
    }

    const payload =
        JSON.parse(text);

    const candidates =
        Array.isArray(payload?.results)
            ? payload.results
            : [];

    const deduplicated =
        deduplicateCandidates(
            candidates
        );

    // Attach original creation timestamps to recalled memories.
    const ids = deduplicated
        .map(item => item.id)
        .filter(Boolean);

    if (ids.length > 0) {
        const { data: timestamps, error } = await supabase
            .from("memories")
            .select("id, created_at")
            .in("id", ids);

        if (error) {
            console.error(
                "[RECALL] failed to load memory timestamps:",
                error.message
            );
        } else {
            const createdAtById = new Map(
                (timestamps ?? []).map(item => [
                    item.id,
                    item.created_at
                ])
            );

            for (const item of deduplicated) {
                item.created_at =
                    createdAtById.get(item.id) ?? undefined;
            }
        }
    }

    console.log(
        "[RECALL] candidates:",
        candidates.length,
        "-> deduplicated:",
        deduplicated.length
    );

    return deduplicated;
}