import type { ActivationProvider } from "../types";

import { MemoryProvider } from "./memory";
import { GraphProvider } from "./graph";
import { BeliefProvider } from "./belief";
import { IdentityProvider } from "./identity";
import { CuriosityProvider } from "./curiosity";


export const providers: ActivationProvider[] = [

    new MemoryProvider(),

    new GraphProvider(),

    new BeliefProvider(),

    new IdentityProvider(),

    new CuriosityProvider()

];