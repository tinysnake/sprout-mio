export type ToolStep = { name: string; arguments: Record<string, unknown> };
export type TurnPlan =
  | { expectedUserText: string; steps: ToolStep[]; reply: string }
  | { lease: { action: string; parameters: Record<string, unknown> }; reply: string };
export type FixtureRole = "operator" | "nonHolder" | "status";
export const fixtureProvider: string;
export const fixtureModels: Readonly<Record<FixtureRole, string>>;
export function statusTurn(): Extract<TurnPlan, { expectedUserText: string }>;
export function leaseTurn(action: string, parameters: Record<string, unknown>): TurnPlan;
export function startModelFixture(options: {
  privateDir: string;
  sourceAgentDir?: string;
}): Promise<{
  agentDir: string;
  model(role: FixtureRole): string;
  arm(role: FixtureRole, turn: TurnPlan): void;
  assertHealthy(): void;
  assertDrained(): void;
  metadata(): {
    mode: string;
    provider: string;
    thinking: string;
    requestCount: number;
    models: { model: string; completedPlans: number; unusedPlans: number; unusedSteps: number }[];
    failed: boolean;
    paidModelCalls: number;
    paidModelCallsBasis: string;
  };
  close(): Promise<void>;
}>;
