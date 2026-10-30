export type ResourceName =
  | "process"
  | "native"
  | "browser"
  | "unit"
  | "development"
  | "sdk"
  | "light"
  | "port3141"
  | "port3144";
export type ResourceClaims = Partial<Record<ResourceName, number>>;
export type GatePlan = Readonly<{
  estimatedMs: number;
  resources: Readonly<ResourceClaims>;
  preparation: readonly string[];
  sandbox: boolean;
}>;
export const SUITE_CAPACITY: Readonly<Record<ResourceName, number>>;
export const SUITE_PLAN: Readonly<Record<string, GatePlan>>;
export function fitsResources(used: ResourceClaims, requested: ResourceClaims): boolean;
export function allocateResources(
  used: ResourceClaims,
  requested: ResourceClaims,
  direction: 1 | -1,
): void;
