#!/usr/bin/env node
// 从真实的 gate timing 报告规划六个容器 job 的门禁归属：
//   node scripts/verify/ci-balance.mjs <report.json...>
// 输入是 runner 写进 .verify/runs/<run>/report.json 的报告（每个 job 一份），
// 单位毫秒。输出当前归属、LPT 上限参考和从现有归属出发的再平衡方案及其预测耗时。
// 预测 = install 准备 + 组内 server 构建（若该组有 server 门禁）+ 组内门禁耗时之和；
// 它不是 Actions 实测，实测会包含 checkout、runner 排队和同一 runner 上的其他抖动。
// --durations=max 用采样里的最大单次耗时规划，作为噪声上界检查；默认取均值。
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
const mode = args.includes("--durations=max") ? "max" : "mean";
const paths = args.filter((argument) => !argument.startsWith("--"));
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
