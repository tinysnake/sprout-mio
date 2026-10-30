#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ledger = join(root, ".verify", "spend.jsonl");
const runsDirectory = join(root, ".verify", "runs");
const formatDuration = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);

function readLedger() {
  if (!existsSync(ledger)) return [];
  const entries = [];
  for (const line of readFileSync(ledger, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return entries;
}

// 账本可能是空的（更早的运行发生在记账之前）：把残留报告补进来，不漏历史。
function backfill() {
  if (!existsSync(runsDirectory)) return [];
  const entries = [];
  for (const name of require$readdir()) {
    const path = join(runsDirectory, name, "report.json");
    if (!existsSync(path)) continue;
    const report = JSON.parse(readFileSync(path, "utf8"));
    entries.push({
      at: report.finishedAt,
      head: null,
      target: report.target ?? "all",
      selection: report.selection,
      durationMs: report.durationMs,
      count: report.count,
      failed: report.failed,
      gates: (report.outcomes ?? []).map((outcome) => ({
        id: outcome.id,
        status: outcome.status,
        durationMs: Math.round(outcome.durationMs),
      })),
    });
  }
  return entries;
}

function require$readdir() {
  return readdirSync(runsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function main() {
  const recorded = readLedger();
  const known = new Set(recorded.map((entry) => `${entry.at}|${entry.durationMs}`));
  const entries = [
    ...backfill().filter((entry) => !known.has(`${entry.at}|${entry.durationMs}`)),
    ...recorded,
  ].sort((left, right) => String(left.at).localeCompare(String(right.at)));
  if (entries.length === 0) {
    console.log("no verification spend recorded yet");
    return 0;
  }
  const total = entries.reduce((sum, entry) => sum + entry.durationMs, 0);
  console.log(`runs=${entries.length} total=${formatDuration(total)}`);
  console.log("");
  console.log("By target");
  const byTarget = new Map();
  for (const entry of entries) {
    const current = byTarget.get(entry.target) ?? { runs: 0, ms: 0, failed: 0 };
    current.runs += 1;
    current.ms += entry.durationMs;
    current.failed += entry.failed;
    byTarget.set(entry.target, current);
  }
  for (const [target, stat] of [...byTarget].sort((left, right) => right[1].ms - left[1].ms))
    console.log(
      `  ${formatDuration(stat.ms).padStart(8)} ${String(stat.runs).padStart(3)} runs ${target} (failed gates ${stat.failed})`,
    );
  console.log("");
  console.log("Slowest gates (aggregate)");
  const byGate = new Map();
  for (const entry of entries)
    for (const gate of entry.gates) {
      const current = byGate.get(gate.id) ?? { runs: 0, ms: 0, failed: 0 };
      current.runs += 1;
      current.ms += gate.durationMs;
      if (gate.status !== "passed") current.failed += 1;
      byGate.set(gate.id, current);
    }
  for (const [id, stat] of [...byGate].sort((left, right) => right[1].ms - left[1].ms).slice(0, 12))
    console.log(
      `  ${formatDuration(stat.ms).padStart(8)} ${String(stat.runs).padStart(3)}x ${id}${stat.failed ? ` (failed ${stat.failed})` : ""}`,
    );
  console.log("");
  console.log("Repeated work on one HEAD");
  const byHead = new Map();
  for (const entry of entries) {
    const key = entry.head ?? "(unknown)";
    byHead.set(key, [...(byHead.get(key) ?? []), entry]);
  }
  let repeats = 0;
  for (const [head, list] of byHead) {
    const full = list.filter((entry) => entry.target === "all");
    if (full.length < 2) continue;
    repeats += full.length - 1;
    console.log(
      `  ${head.slice(0, 12)} ${full.length} full runs: ${full.map((entry) => `${formatDuration(entry.durationMs)}/${entry.failed ? `${entry.failed} failed` : "0 failed"}`).join(" ")}`,
    );
  }
  if (repeats === 0) console.log("  none recorded");
  return 0;
}

process.exitCode = main();
