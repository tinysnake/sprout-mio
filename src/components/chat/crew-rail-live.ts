import { createContext } from "react";
import type { AppResult } from "../../contracts/result";
import type { CrewDelegationRail } from "../../contracts/delegation";

export type CrewRailFacts = { chatId: string; result: AppResult<CrewDelegationRail> };
export const CrewRailFactsContext = createContext<((facts: CrewRailFacts) => void) | null>(null);
