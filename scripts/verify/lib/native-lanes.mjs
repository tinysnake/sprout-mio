export const AH_GROUPS = Object.freeze(["execution", "cancellation", "recovery"]);

export const NATIVE_LANE_BUDGET = 4;

export const NATIVE_GATE_WEIGHTS = Object.freeze({
  "ah-execution-live-e2e": AH_GROUPS.length,
  "aj-recovery-matrix": NATIVE_LANE_BUDGET,
  "u-machine-ui": 1,
  "w-worker-remote": 1,
  "t-machine-worker": 1,
});
