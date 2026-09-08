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


        const topSignal =
            [...result.items]
                .sort(
                    (a, b) =>
                        b.importance -
                        a.importance
                )[0];


        return [
            {
                source: "curiosity",

                content:
                    "- " +
                    topSignal.content,

                score:
                    topSignal.importance,

                metadata: {
                    signals:
                        result.signals
                }
            }
        ];

    }

}