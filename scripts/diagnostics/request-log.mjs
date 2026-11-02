#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PREFIX = "[request] ";

export function summarize(text) {
  const groups = new Map();
  const total = { count: 0, bytes: 0, serverErrors: 0, incomplete: 0 };
  for (const line of text.split("\n")) {
    if (!line.startsWith(PREFIX)) continue;
    let record;
    try {
      record = JSON.parse(line.slice(PREFIX.length));
    } catch {
      continue;
    }
    if (record === null || typeof record !== "object") continue;
    const key = record.fn ?? record.fnId ?? record.path;
    if (typeof key !== "string") continue;
    const bytes = typeof record.bytes === "number" ? record.bytes : 0;
    let group = groups.get(key);
    if (!group) {
      group = { key, count: 0, bytes: 0, ms: [], serverErrors: 0, incomplete: 0 };
      groups.set(key, group);
    }
    group.count += 1;
    group.bytes += bytes;
    if (typeof record.ms === "number") group.ms.push(record.ms);
    if (typeof record.status === "number" && record.status >= 500) group.serverErrors += 1;
    if (record.complete === false) group.incomplete += 1;
    total.count += 1;
    total.bytes += bytes;
    if (typeof record.status === "number" && record.status >= 500) total.serverErrors += 1;
    if (record.complete === false) total.incomplete += 1;
  }
  const rows = [...groups.values()]
    .map((group) => {
      const sorted = [...group.ms].sort((a, b) => a - b);
      return {
        key: group.key,
        count: group.count,
        bytes: group.bytes,
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        max: sorted.length > 0 ? sorted[sorted.length - 1] : 0,
        serverErrors: group.serverErrors,
        incomplete: group.incomplete,
      };
    })
    .sort((a, b) => b.bytes - a.bytes || b.count - a.count || a.key.localeCompare(b.key));
  const samples = [...groups.values()].flatMap((group) => group.ms).sort((a, b) => a - b);
  return {
    rows,
    total: {
      ...total,
      p50: percentile(samples, 0.5),
      p95: percentile(samples, 0.95),
      max: samples.length > 0 ? samples[samples.length - 1] : 0,
    },
  };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.min(Math.max(index, 0), sorted.length - 1)];
}

const COLUMNS = ["target", "count", "bytes", "p50ms", "p95ms", "maxms", "5xx", "incomplete"];

function format(source) {
  const { rows, total } = summarize(source);
  const body = [
    ...rows.map((item) => [
      item.key,
      item.count,
      item.bytes,
      item.p50,
      item.p95,
      item.max,
      item.serverErrors,
      item.incomplete,
    ]),
    [
      "TOTAL",
      total.count,
      total.bytes,
      total.p50,
      total.p95,
      total.max,
      total.serverErrors,
      total.incomplete,
    ],
  ];
  const widths = COLUMNS.map((name, i) =>
    Math.max(name.length, ...body.map((values) => String(values[i]).length)),
  );
  const row = (values) =>
    values
      .map((value, i) =>
        i === 0 ? String(value).padEnd(widths[i]) : String(value).padStart(widths[i]),
      )
      .join("  ");
  return `${[row(COLUMNS), ...body.map(row)].join("\n")}\n`;
}

function main(argv) {
  const file = argv[2];
  if (!file) {
    console.error("用法: node scripts/diagnostics/request-log.mjs <log-file>");
    process.exit(1);
  }
  let source;
  try {
    source = readFileSync(file, "utf8");
  } catch (error) {
    console.error(`读取失败: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  process.stdout.write(format(source));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv);
