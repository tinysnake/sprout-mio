export function timestampMs(value) {
  const ms = typeof value === "string" ? Date.parse(value) : value;
  return typeof ms === "number" && Number.isFinite(ms) ? ms : null;
}

export function runDurationMs(run) {
  const start = timestampMs(run.startedAt);
  const end = timestampMs(run.settledAt);
  return start !== null && end !== null && end >= start ? end - start : null;
}

export function totalRunMs(runs) {
  const durations = runs.map(runDurationMs);
  return durations.length && durations.every((ms) => ms !== null)
    ? durations.reduce((sum, ms) => sum + ms, 0)
    : null;
}
