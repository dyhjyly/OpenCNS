import { providers } from "./providers";
import { buildContext, ReflexContext } from "./context";

export async function runReflex(
    query: string
): Promise<ReflexContext> {

    const results = await Promise.all(
        providers.map(provider => provider.activate(query))
    );

    const activations = results.flat();

    return buildContext(activations);
}


/**
 * 兼容旧版 Scheduler
 */
export const ReflexModule = {

    async run() {

        const context = await runReflex("");

        return {
            decision: "continue",
            context
        };
    }
};
