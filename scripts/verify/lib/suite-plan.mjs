import { NATIVE_LANE_BUDGET, AH_GROUPS } from "./native-lanes.mjs";

export const SUITE_CAPACITY = Object.freeze({
  process: 6,
  native: NATIVE_LANE_BUDGET,
  browser: 2,
  unit: 1,
  development: 2,
  sdk: 1,
  light: 2,
  port3141: 1,
  port3144: 1,
});

const server = ["install", "server"];
const worker = ["install", "server", "worker"];
const extension = ["install", "extension"];
const privateTree = ["install"];
function plan(seconds, resources, preparation = [], sandbox = false) {
  return Object.freeze({
    estimatedMs: Math.round(seconds * 1000),
    resources: Object.freeze({ process: 1, ...resources }),
    preparation: Object.freeze([...preparation]),
    sandbox,
  });
}

export const SUITE_PLAN = Object.freeze({
  "a-base": plan(26.862, { development: 1, unit: 1, sdk: 1 }, privateTree, true),
  "aa-execution-log-contracts": plan(1.552, { unit: 1 }),
  "ab-worker-long-command": plan(33.303, { native: 1 }, worker),
  "ac-execution-recovery-log": plan(0.653, { unit: 1 }),
  "ad-execution-log-ui": plan(32.693, { development: 1, browser: 1 }, privateTree, true),
  "ae-remote-tools-cancel-log": plan(1.047, { unit: 1, sdk: 1 }),
  "af-execution-cancel-authority": plan(2.329, { unit: 1 }),
  "ag-execution-wiring-ui": plan(7.621, { browser: 1, light: 1, port3141: 1 }, server),
  "ah-execution-live-e2e": plan(94.515, { native: AH_GROUPS.length }, worker),
  "ai-execution-accept-fixes": plan(1.614, { unit: 1 }),
  "aj-recovery-matrix": plan(62.067, { native: NATIVE_LANE_BUDGET }, worker),
  "ak-execution-accept-fixes-2": plan(12.173, { unit: 1, native: 1 }),
  "al-execution-exit-custody": plan(12.665, { unit: 1, native: 1 }),
  "am-execution-log-honesty": plan(4.098, { browser: 1 }, server),
  "b-tooling": plan(29.198, { unit: 1, sdk: 1 }, privateTree, true),
  "c-auth-rate-limit": plan(1.364, { light: 1 }, server),
  "c-data-auth": plan(5.451, { development: 1, unit: 1, browser: 1 }, privateTree, true),
  "d-runtime": plan(17.213, { development: 1, unit: 1 }, privateTree, true),
  "drain-http": plan(21.867, { light: 1, port3144: 1 }, server),
  "e-project": plan(3.402, { light: 1, port3141: 1 }, server),
  "f-docs": plan(0.105, { light: 1 }),
  "g-identity-data": plan(9.212, { unit: 1, light: 1 }, server),
  "h-project-agents": plan(4.554, { light: 1 }, server),
  "i-chat": plan(9.15, { light: 1, sdk: 1 }, server),
  "j-info-hub": plan(4.248, { light: 1, port3144: 1 }, server),
  "k-acceptance": plan(37.381, { browser: 1 }, server),
  "k2-cross-family-isolation": plan(4.315, { light: 1 }, server),
  "l-docs": plan(1.286, { light: 1 }),
  "l-docs-probes": plan(34.493, { light: 1 }),
  "m-error-mapping": plan(0.96, { light: 1 }, server),
  "n-pi-session": plan(11.366, { light: 1, sdk: 1 }),
  "o-turn-semantics": plan(6.852, { light: 1 }, server),
  "p-repo-entry": plan(17.083, { light: 1 }, server),
  "q-info-hub-runs": plan(4.037, { light: 1 }, server),
  "r-ui-layout": plan(18.471, { browser: 1 }, server),
  "s-machine-contracts": plan(3.415, { unit: 1 }),
  "t-machine-worker": plan(49.772, { native: 1, browser: 1, development: 1 }, worker, true),
  "u-machine-ui": plan(73.479, { native: 1, browser: 1 }, worker),
  "v-lease-contracts": plan(2.733, { unit: 1 }),
  "v-mcp-contracts": plan(9.248, { unit: 1 }),
  "w-worker-remote": plan(62.305, { native: 1, browser: 1 }, worker),
  "x-remote-tools": plan(2.214, { unit: 1, sdk: 1 }),
  "x2-mcp-extension": plan(11.559, { unit: 1, sdk: 1 }, extension),
  "x3-mcp-extension-surface": plan(2.426, { unit: 1, sdk: 1 }),
  "y-lease-ui": plan(34.342, { development: 1, browser: 1 }, privateTree, true),
  "y-mcp-worker": plan(5.786, { unit: 1, native: 1, sdk: 1 }),
  "y2-mcp-http-worker": plan(2.925, { unit: 1, native: 1, sdk: 1 }, ["install", "worker"]),
  "z-lease-integration": plan(47.407, { native: 1, browser: 1, sdk: 1 }, worker),
  "z2-mcp-integration": plan(11.492, { unit: 1, native: 1, sdk: 1 }),
  "z3-mcp-acceptance": plan(25.104, { unit: 1, native: 2, sdk: 1 }, [...worker, "extension"]),
});

export function fitsResources(used, requested) {
  return Object.entries(requested).every(
    ([name, count]) => (used[name] ?? 0) + count <= SUITE_CAPACITY[name],
  );
}

export function allocateResources(used, requested, direction) {
  for (const [name, count] of Object.entries(requested))
    used[name] = (used[name] ?? 0) + count * direction;
}
