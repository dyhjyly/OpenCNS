import type { Activation } from "../types";

export interface ReflexContext {

    memory: Activation[];

    graph: Activation[];

    belief: Activation[];

    identity: Activation[];

    curiosity: Activation[];

    total: number;
}

export function buildContext(
    activations: Activation[]
): ReflexContext {

    const sorted = activations
        .filter(item => item.content.length > 0)
        .sort((a, b) => b.score - a.score);

    return {

    memory: sorted.filter(
        item => item.source === "memory"
    ),

    graph: sorted.filter(
        item => item.source === "graph"
    ),

    belief: sorted.filter(
        item => item.source === "belief"
    ),

    identity: sorted.filter(
        item => item.source === "identity"
    ),

    curiosity: sorted.filter(
        item => item.source === "curiosity"
    ),

    total: sorted.length
    };
}
