// 报告目录会裁剪，时间开销要单独留账：一次验证花了多久、同一 HEAD 跑了几遍。
export function spendEntry(report, head) {
  return {
    at: report.finishedAt,
    head,
    target: report.target,
    selection: report.selection,
    durationMs: report.durationMs,
    count: report.count,
    failed: report.failed,
    gates: report.outcomes.map((outcome) => ({
      id: outcome.id,
      status: outcome.status,
      durationMs: Math.round(outcome.durationMs),
    })),
  };
}

export function parseLedger(text) {
  const entries = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return entries;
}

// 同一 HEAD 已经有一轮 0 失败的全量，就不必再花半小时跑同样的东西。
export function greenFullRunOn(text, head) {
  if (!head) return null;
  for (const entry of parseLedger(text).reverse())
    if (entry.head === head && entry.target === "all" && entry.failed === 0 && entry.count > 0)
      return entry;
  return null;
}
