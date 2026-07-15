import type {
    Activation,
    ActivationProvider
} from "../../types";

import {
    CuriosityModule
} from "../../../curiosity/index.js";


export class CuriosityProvider
implements ActivationProvider {


    async activate(
        query: string
    ): Promise<Activation[]> {


        void query;


        const result =
            await CuriosityModule.run();


        if (
            !result.items ||
            result.items.length === 0
        ) {
            return [];
        }


        return [
            {
                source: "curiosity",
                content: JSON.stringify(
                    result.items
                ),
                score: 0.8,
                metadata: {
                    signals:
                        result.signals
                }
            }
        ];

    }

}
