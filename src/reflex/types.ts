export interface Activation {
    source: string;
    content: string;
    score: number;
    metadata?: Record<string, unknown>;
}

export interface ActivationProvider {
    activate(query: string): Promise<Activation[]>;
}

