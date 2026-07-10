import type {
    Activation,
    ActivationProvider
} from "../../types";

export class BeliefProvider implements ActivationProvider {
    async activate(query: string): Promise<Activation[]> {
        void query;

        return [];
    }
}
