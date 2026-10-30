import { NATIVE_LANE_BUDGET, NATIVE_GATE_WEIGHTS, AH_GROUPS } from "./native-lanes.mjs";

export const SUITE_CAPACITY = Object.freeze({
  process: 6,
  native: NATIVE_LANE_BUDGET,
  browser: 3,
  unit: 2,
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
  "a-base": plan(54.969, { development: 1, unit: 1 }, privateTree, true),
  "aa-execution-log-contracts": plan(1.648, { unit: 1 }),
  "ab-worker-long-command": plan(34.493, { native: 1 }, worker),
  "ac-execution-recovery-log": plan(0.791, { unit: 1 }),
  "ad-execution-log-ui": plan(49.473, { development: 1, browser: 1 }, privateTree, true),
  "ae-remote-tools-cancel-log": plan(0.793, { unit: 1, sdk: 1 }),
  "af-execution-cancel-authority": plan(2.124, { unit: 1 }),
  "ag-execution-wiring-ui": plan(8.91, { browser: 1, light: 1, port3141: 1 }, server),
  "ah-execution-live-e2e": plan(96.803, { native: AH_GROUPS.length }, worker),
  "ai-execution-accept-fixes": plan(1.636, { unit: 1 }),
  "aj-recovery-matrix": plan(63.872, { native: NATIVE_GATE_WEIGHTS["aj-recovery-matrix"] }, worker),
  "ak-execution-accept-fixes-2": plan(12.582, { unit: 1, native: 1 }),
  "al-execution-exit-custody": plan(12.791, {
    process: SUITE_CAPACITY.process,
    unit: 1,
    native: 1,
  }),
  "am-execution-log-honesty": plan(5.358, { browser: 1 }, server),
  "aq-p4d-pages": plan(19, { browser: 1 }, server),
  "b-tooling": plan(69.675, { process: SUITE_CAPACITY.process, unit: 1 }, privateTree, true),
  "c-auth-rate-limit": plan(2.16, { light: 1 }, server),
  "c-data-auth": plan(21.026, { development: 1, unit: 1, browser: 1 }, privateTree, true),
  "d-runtime": plan(34.501, { development: 1, unit: 1 }, privateTree, true),
  "drain-http": plan(22.57, { light: 1, port3144: 1 }, server),
  "e-project": plan(4.284, { light: 1, port3141: 1 }, server),
  "f-docs": plan(0.161, { light: 1 }),
  "g-identity-data": plan(11.336, { unit: 1, light: 1 }, server),
  "h-project-agents": plan(5.78, { light: 1 }, server),
  "i-chat": plan(10.695, { light: 1 }, server),
  "i2-group-chat": plan(12, { light: 1 }, server),
  "i3-public-channel": plan(12, { light: 1 }, server),
  "i4-agent-fanout": plan(12, { light: 1 }, server),
  "i5-project-removal": plan(4, { light: 1 }),
  "i6-chat-info": plan(10, { light: 1 }, server),
  "i7-chat-scope": plan(10, { light: 1 }, server),
  "an-p4d-authority": plan(14.016, { process: 1, light: 1 }),
  "j-info-hub": plan(8.758, { light: 1, port3144: 1 }, server),
  "k-acceptance": plan(41.234, { browser: 1 }, server),
  "k2-cross-family-isolation": plan(5.636, { light: 1 }, server),
  "l-docs": plan(2.341, { light: 1 }),
  "l-docs-probes": plan(81.072, { light: 1 }),
  "m-error-mapping": plan(1.362, { light: 1 }, server),
  "n-pi-session": plan(14.426, { light: 1 }, server),
  "o-turn-semantics": plan(12.68, { light: 1 }, server),
  "p-repo-entry": plan(34.693, { light: 1 }, server),
  "q-info-hub-runs": plan(11.792, { light: 1, unit: 1 }, server),
  "r-ui-layout": plan(18.961, { browser: 1 }, server),
  "s-machine-contracts": plan(3.11, { unit: 1 }),
  "t-machine-worker": plan(67.424, { native: 1, browser: 1, development: 1 }, worker, true),
  "u-machine-ui": plan(75.372, { native: 1, browser: 1 }, worker),
  "v-lease-contracts": plan(2.619, { unit: 1 }),
  "v-mcp-contracts": plan(11.609, { unit: 1 }),
  "w-worker-remote": plan(66.076, { native: 1, browser: 1 }, worker),
  "ap-p4d-handoff-worker": plan(74, { native: 1, browser: 1 }, worker),
  "az-p5a-live-worker": plan(120, { native: 1, browser: 1 }, worker),
  "x-remote-tools": plan(2.063, { unit: 1, sdk: 1 }),
  "x2-mcp-extension": plan(13.791, { unit: 1, sdk: 1 }, extension),
  "x3-mcp-extension-surface": plan(2.805, { unit: 1, sdk: 1 }),
  "y-lease-ui": plan(60.044, { development: 1, browser: 1 }, privateTree, true),
  "y-mcp-worker": plan(5.408, { unit: 1, native: 1, sdk: 1 }),
  "y2-mcp-http-worker": plan(1.933, { unit: 1, native: 1, sdk: 1 }, ["install", "worker"]),
  "z-lease-integration": plan(52.166, { native: 1, browser: 1, sdk: 1 }, worker),
  "z2-mcp-integration": plan(11.638, { unit: 1, native: 1, sdk: 1 }),
  "z3-mcp-acceptance": plan(27.517, { unit: 1, native: 2, sdk: 1 }, [...worker, "extension"]),
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
