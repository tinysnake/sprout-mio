import { SUITE_PLAN } from "./suite-plan.mjs";

const compare = (left, right) => left.localeCompare(right);
const minimumPeakImprovementMs = 1;

function mean(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

export function gateSamples(reports) {
  const samples = new Map();
  for (const report of reports) {
    const seen = new Set();
    for (const outcome of report.outcomes) {
      if (seen.has(outcome.id)) throw new Error(`Duplicate gate in one report: ${outcome.id}`);
      seen.add(outcome.id);
      if (
        outcome.status !== "passed" ||
        !Number.isFinite(outcome.durationMs) ||
        outcome.durationMs < 0
      )
        throw new Error(`Invalid successful gate timing: ${outcome.id}`);
      const list = samples.get(outcome.id) ?? [];
      list.push(outcome.durationMs);
      samples.set(outcome.id, list);
    }
  }
  return samples;
}

export function validateCoverage(samples, groups) {
  const assigned = Object.values(groups).flat();
  if (new Set(assigned).size !== assigned.length) throw new Error("Duplicate gate in the plan");
  const missing = assigned.filter((id) => !samples.has(id)).sort(compare);
  if (missing.length) throw new Error(`Reports do not cover assigned gates: ${missing.join(",")}`);
  const extra = [...samples.keys()].filter((id) => !assigned.includes(id)).sort(compare);
  if (extra.length) throw new Error(`Reports contain unassigned gates: ${extra.join(",")}`);
}

export function gateDurations(samples) {
  const durations = new Map();
  for (const [id, list] of samples)
    durations.set(id, { ms: mean(list), maxMs: Math.max(...list), samples: list.length });
  return durations;
}

export function preparationModel(reports) {
  const observed = { install: [], server: [] };
  for (const report of reports)
    for (const entry of report.preparation ?? [])
      if (entry.kind in observed) {
        if (entry.status !== "passed" || !Number.isFinite(entry.durationMs) || entry.durationMs < 0)
          throw new Error(`Invalid successful preparation timing: ${entry.kind}`);
        observed[entry.kind].push(entry.durationMs);
      }
  for (const [kind, values] of Object.entries(observed))
    if (values.length === 0) throw new Error(`Reports contain no ${kind} preparation`);
  return { installMs: mean(observed.install), serverMs: mean(observed.server) };
}

function needsServer(gates) {
  return gates.some((id) => SUITE_PLAN[id]?.preparation.includes("server"));
}

export function loadMs(gates, durations, preparation) {
  const shared = preparation.installMs + (needsServer(gates) ? preparation.serverMs : 0);
  return shared + gates.reduce((total, id) => total + durations.get(id).ms, 0);
}

function loads(groups, durations, preparation) {
  return Object.fromEntries(
    Object.entries(groups).map(([name, gates]) => [name, loadMs(gates, durations, preparation)]),
  );
}

function peak(loadsByGroup) {
  return Math.max(...Object.values(loadsByGroup));
}

function movedGates(groups, owner) {
  return Object.entries(groups)
    .flatMap(([name, gates]) => gates.filter((id) => owner.get(id) !== name))
    .sort(compare);
}

export function largestProcessingTime({ names, durations, preparation }) {
  const groups = Object.fromEntries(names.map((name) => [name, []]));
  const ordered = [...durations.entries()].sort(
    ([leftId, left], [rightId, right]) => right.ms - left.ms || leftId.localeCompare(rightId),
  );
  for (const [id] of ordered) {
    let target = names[0];
    for (const name of names)
      if (
        loadMs(groups[name], durations, preparation) <
        loadMs(groups[target], durations, preparation)
      )
        target = name;
    groups[target].push(id);
  }
  return { groups, loadsMs: loads(groups, durations, preparation) };
}

export function rebalance({ groups, durations, preparation }) {
  const names = Object.keys(groups);
  const owner = new Map(names.flatMap((name) => groups[name].map((id) => [id, name])));
  const current = Object.fromEntries(names.map((name) => [name, [...groups[name]].sort(compare)]));
  const sorted = () =>
    Object.fromEntries(names.map((name) => [name, [...current[name]].sort(compare)]));

  for (;;) {
    const before = peak(loads(current, durations, preparation));
    let best = null;
    const consider = (candidate) => {
      const candidatePeak = peak(loads(candidate, durations, preparation));
      if (candidatePeak >= before - minimumPeakImprovementMs) return;
      const moved = movedGates(candidate, owner).length;
      if (
        best === null ||
        candidatePeak < best.peak - minimumPeakImprovementMs ||
        (Math.abs(candidatePeak - best.peak) <= minimumPeakImprovementMs && moved < best.moved)
      )
        best = { peak: candidatePeak, moved, groups: candidate };
    };

    for (const from of names) {
      for (const moved of current[from]) {
        for (const to of names) {
          if (to === from) continue;
          const candidate = sorted();
          candidate[from] = candidate[from].filter((id) => id !== moved);
          candidate[to] = [...candidate[to], moved].sort(compare);
          consider(candidate);
        }
      }
    }
    for (const [leftIndex, left] of names.entries()) {
      for (const right of names.slice(leftIndex + 1)) {
        for (const leftGate of current[left]) {
          for (const rightGate of current[right]) {
            const candidate = sorted();
            candidate[left] = [...candidate[left].filter((id) => id !== leftGate), rightGate].sort(
              compare,
            );
            candidate[right] = [
              ...candidate[right].filter((id) => id !== rightGate),
              leftGate,
            ].sort(compare);
            consider(candidate);
          }
        }
      }
    }
    if (best === null) break;
    for (const name of names) current[name] = best.groups[name];
  }

  const moved = Object.entries(current)
    .flatMap(([name, gates]) =>
      gates
        .filter((id) => owner.get(id) !== name)
        .map((id) => ({ id, from: owner.get(id), to: name })),
    )
    .sort((left, right) => compare(left.id, right.id));
  return { groups: current, loadsMs: loads(current, durations, preparation), moved };
}
