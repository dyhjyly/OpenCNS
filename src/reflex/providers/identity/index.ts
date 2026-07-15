import type {
    Activation,
    ActivationProvider
} from "../../types";

import {
    IdentityModule
} from "../../../identity/index.js";

export class IdentityProvider
implements ActivationProvider {

    async activate(
        query: string
    ): Promise<Activation[]> {

        void query;

        const profile =
            await IdentityModule.run();

        if (!profile.summary) {
            return [];
        }

        return [
            {
                source: "identity",
                content: profile.summary,
                score: 0.95,
                metadata: {
                    updated: profile.updated
                }
            }
        ];
    }
}
