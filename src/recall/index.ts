import {
    createRecallNotice
} from "./notice.js";

import {
    retrieveCandidates
} from "./retrieval.js";

import {
    recall
} from "./agent.js";


export async function runRecall(
    query: string
) {

    console.log("[RECALL] notice:start");

    const notice =
        createRecallNotice(query);

    console.log(
        "[RECALL] notice:end",
        notice
    );


    if (!notice.shouldRecall) {

        return {
            recalled: [],
            candidates: [],
            notice,
        };

    }


    console.log(
        "[RECALL] retrieval:start"
    );

    const candidates =
        await retrieveCandidates(
            notice.query
        );

    console.log(
        "[RECALL] retrieval:end",
        `candidates=${candidates.length}`
    );


    console.log(
        "[RECALL] agent:start"
    );

    const result =
        await recall(
            notice.query,
            candidates
        );

    console.log(
        "[RECALL] agent:end",
        `selected=${result.selectedIds.length}`
    );


    const recalled =
        candidates.filter(
            item =>
                result.selectedIds.includes(
                    item.id
                )
        );


    return {

        recalled,

        candidates,

        notice,

    };
}
