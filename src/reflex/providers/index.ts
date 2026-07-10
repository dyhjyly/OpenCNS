import type { ActivationProvider } from "../types";

import { MemoryProvider } from "./memory";
import { GraphProvider } from "./graph";
import { BeliefProvider } from "./belief";

export const providers: ActivationProvider[] = [
    new MemoryProvider(),
    new GraphProvider(),
    new BeliefProvider()
];

