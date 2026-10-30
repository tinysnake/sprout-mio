export const AH_CHECKS: Readonly<
  Record<"execution" | "cancellation" | "recovery", readonly string[]>
>;
export function selectAhGroups(args: string[]): (keyof typeof AH_CHECKS)[];
export function validateAhCoverage(group: string | null, checks: { id: string }[]): void;
