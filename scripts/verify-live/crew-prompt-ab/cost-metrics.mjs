import { totalRunMs } from "./timing.mjs";

const roles = ["lead", "worker"];
const writeTools = new Set(["write", "edit", "sprout_remote_file_write"]);
const probeRequest = /\bprobe\b|\bread[ -]only\b|只读|侦察/iu;
const finiteMs = (value) => Number.isFinite(value) && value >= 0;

export function costMetricsFrom({ transcript, toolNames, timings, delegations } = {}) {
  const runs = Array.isArray(transcript) && transcript.length ? transcript : null;
  const callsFor = (role) => {
    const matching = runs?.filter((run) => run.role === role);
    if (!matching?.length) return null;
    if (matching.some((run) => !Array.isArray(run.tools) || !Array.isArray(toolNames?.[run.runId])))
      return null;
    return matching.flatMap((run) => run.tools);
  };
  const calls = Object.fromEntries(roles.map((role) => [role, callsFor(role)]));
  const wallMs = (role) => {
    const matching = timings?.filter((run) => run.role === role);
    if (!matching?.length) return null;
    return totalRunMs(matching);
  };
  const knownDelegations = Array.isArray(delegations) ? delegations : null;
  const leadCalls = calls.lead;
  const sleeps = leadCalls?.filter((call) => call.name === "sleep");
  const hiddenSleep = leadCalls?.some(
    (call) => call.name === "codemode" && /\bsleep\b/u.test(JSON.stringify(call.arguments)),
  );
  const sleepMsTotal =
    sleeps && !hiddenSleep && sleeps.every((call) => finiteMs(call.arguments?.ms))
      ? sleeps.reduce((sum, call) => sum + call.arguments.ms, 0)
      : null;
  const completeTranscript =
    runs && roles.every((role) => !runs.some((r) => r.role === role) || calls[role]);
  const allCalls = completeTranscript ? Object.values(calls).flatMap((value) => value ?? []) : null;
  const writes = allCalls?.filter((call) => writeTools.has(call.name));
  const hiddenWrite = allCalls?.some(
    (call) =>
      call.name === "codemode" &&
      /\b(write|edit|sprout_remote_file_write)\b/u.test(JSON.stringify(call.arguments)),
  );
  const requests = knownDelegations?.map((delegation) => delegation.requestSummary);
  const knownRequests = requests?.every((request) => typeof request === "string");
  const paths = writes
    ?.filter((call) => call.isError === false)
    .map((call) => call.arguments?.path);
  const settledWrites = writes?.every((call) => typeof call.isError === "boolean");
  const normalizePath = (path) => path.replace(/^\/?private\/tmp\//u, "/tmp/");
  const unmappedArtifacts =
    paths &&
    !hiddenWrite &&
    settledWrites &&
    knownRequests &&
    paths.every((path) => typeof path === "string" && path.length)
      ? [...new Set(paths.map(normalizePath))].filter(
          (path) =>
            !requests.some((request) => {
              const candidates = request.match(/\/?(?:[\w.@-]+\/)*[\w@-]+\.[\w.-]+/gu) ?? [];
              return candidates.some((candidate) => {
                const normalized = normalizePath(candidate);
                return path === normalized || path.endsWith(`/${normalized}`);
              });
            }),
        ).length
      : null;
  return {
    delegations: knownDelegations?.length ?? null,
    probeDelegations: knownRequests
      ? requests.filter((request) => probeRequest.test(request)).length
      : null,
    unmappedArtifacts,
    leadWallMs: wallMs("lead"),
    workerWallMs: wallMs("worker"),
    sleepMsTotal,
    toolCallsByRole: Object.fromEntries(roles.map((role) => [role, calls[role]?.length ?? null])),
  };
}

export function pairedCostRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row.task, row.repeat]);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].flatMap((group) =>
    [...group]
      .sort((a, b) => a.arm.localeCompare(b.arm))
      .map((row) => ({
        task: `${row.task} #${row.repeat} / ${row.arm}`,
        ...Object.fromEntries(
          [
            "delegations",
            "probeDelegations",
            "unmappedArtifacts",
            "leadWallMs",
            "workerWallMs",
            "sleepMsTotal",
          ].map((key) => [key, row[key] ?? null]),
        ),
      })),
  );
}
