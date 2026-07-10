import type {
    Activation,
    ActivationProvider
} from "../../types";

import { MemoryModule } from "../../../memory/index.js";

export class MemoryProvider implements ActivationProvider {

    async activate(query: string): Promise<Activation[]> {

        const result = await MemoryModule.search({
            query
        });

        if (!result) {
            return [];
        }

        return [
            {
                source: "memory",
                content: JSON.stringify(result),
                score: 1,
                metadata: {
                    query
                }
            }
        ];
    }
}
