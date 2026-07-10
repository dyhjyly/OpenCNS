import type {
    Activation,
    ActivationProvider
} from "../../types";

export class GraphProvider implements ActivationProvider {
    async activate(query: string): Promise<Activation[]> {
        void query;

        return [];
    }
}
