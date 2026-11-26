#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { CI_GROUPS, CONTAINER_GROUPS } from "./lib/targets-plan.mjs";
import {
  gateDurations,
  gateSamples,
  largestProcessingTime,
  loadMs,
  preparationModel,
  rebalance,
  validateCoverage,
} from "./lib/ci-balance.mjs";

const args = process.argv.slice(2);
const paths = [];
let mode = "mean";
for (const argument of args) {
  if (argument === "--durations=max") mode = "max";
  else if (argument === "--durations=mean") mode = "mean";
  else if (argument.startsWith("--")) throw new Error(`Unknown option: ${argument}`);
  else paths.push(argument);
}
if (paths.length === 0) {
  console.error("Usage: ci-balance.mjs [--durations=mean|max] <report.json...>");
  process.exit(1);
}

const reports = paths.map((path) => JSON.parse(readFileSync(path, "utf8")));
const groups = Object.fromEntries(CONTAINER_GROUPS.map((name) => [name, CI_GROUPS[name]]));
const samples = gateSamples(reports);
validateCoverage(samples, groups);
const durations = new Map(
  [...gateDurations(samples)].map(([id, value]) => [
    id,
    { ...value, ms: mode === "max" ? value.maxMs : value.ms },
  ]),
);
const preparation = preparationModel(reports);
const current = {
  groups,
  loadsMs: Object.fromEntries(
    CONTAINER_GROUPS.map((name) => [name, loadMs(groups[name], durations, preparation)]),
  ),
};

console.log(
  JSON.stringify(
    {
      units: "milliseconds",
      durations: mode,
      inputs: reports.map((report, index) => ({
        path: paths[index],
        runId: report.runId,
        startedAt: report.startedAt,
      })),
      preparation,
      current,
      largestProcessingTime: largestProcessingTime({
        names: CONTAINER_GROUPS,
        durations,
        preparation,
      }),
      proposed: rebalance({ groups, durations, preparation }),
    },
    null,
    2,
  ),
);
