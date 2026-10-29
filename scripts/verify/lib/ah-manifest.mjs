import { AH_GROUPS } from "./native-lanes.mjs";

export const AH_CHECKS = Object.freeze({
  execution: Object.freeze(["service", "tools", "worker", "S1", "S2", "S3", "S4/S10"]),
  cancellation: Object.freeze(["S11", "S6", "S6b", "S6c", "S7"]),
  recovery: Object.freeze(["S8", "S12", "S9", "S5"]),
});

export function selectAhGroups(args) {
  if (args.length === 0) return [...AH_GROUPS];
  if (args.length === 2 && args[0] === "--group" && AH_GROUPS.includes(args[1])) return [args[1]];
  throw new Error(`Expected no arguments or --group ${AH_GROUPS.join("|")}`);
}

export function validateAhCoverage(group, checks) {
  const expected = group === null ? Object.values(AH_CHECKS).flat() : AH_CHECKS[group];
  if (!expected) throw new Error(`Unknown AH group: ${group}`);
  const ids = checks.map((check) => check.id);
  if (
    ids.length !== expected.length ||
    new Set(ids).size !== ids.length ||
    expected.some((id) => !ids.includes(id))
  )
    throw new Error(
      `Invalid AH coverage for ${group}: expected ${expected.join(",")}; got ${ids.join(",")}`,
    );
}
