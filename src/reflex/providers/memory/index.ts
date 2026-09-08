import type {
    Activation,
    ActivationProvider
} from "../../types";

export class MemoryProvider
implements ActivationProvider {

    async activate(
        query: string
    ): Promise<Activation[]> {

        void query;

        /*
         * Long-term memory retrieval
         * is now handled exclusively by Recall.
         *
         * Reflex must not search memories
         * automatically on every message.
         */

        return [];
    }
}
