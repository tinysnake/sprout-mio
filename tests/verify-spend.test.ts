import { describe, expect, it } from "vite-plus/test";
import { greenFullRunOn, parseLedger, spendEntry } from "../scripts/verify/lib/spend.mjs";

const report = {
  finishedAt: "2026-10-30T17:00:00.000Z",
  target: "all",
  selection: null,
  durationMs: 1234,
  count: 2,
  failed: 0,
  outcomes: [
    { id: "a-base", status: "passed", durationMs: 12.4 },
    { id: "b-tooling", status: "passed", durationMs: 56.6 },
  ],
};

describe("verify spend ledger", () => {
  it("records one line per run with rounded gate durations", () => {
    expect(spendEntry(report, "abc")).toEqual({
      at: "2026-10-30T17:00:00.000Z",
      head: "abc",
      target: "all",
      selection: null,
      durationMs: 1234,
      count: 2,
      failed: 0,
      gates: [
        { id: "a-base", status: "passed", durationMs: 12 },
        { id: "b-tooling", status: "passed", durationMs: 57 },
      ],
    });
  });

  it("skips a repeated full run only when the same HEAD already passed", () => {
    const line = (head: string, target: string, failed: number) =>
      `${JSON.stringify({ head, target, failed, count: 61, durationMs: 1, at: "t" })}\n`;
    const ledger = line("a", "all", 0) + line("b", "all", 3) + line("a", "local", 0);
    expect(greenFullRunOn(ledger, "a")?.head).toBe("a");
    expect(greenFullRunOn(ledger, "b")).toBeNull();
    expect(greenFullRunOn(ledger, "c")).toBeNull();
    expect(greenFullRunOn(ledger, null)).toBeNull();
    expect(greenFullRunOn("", "a")).toBeNull();
  });

  it("ignores a corrupt ledger line instead of losing the whole history", () => {
    const entries = parseLedger(`{"head":"a"}\nnot json\n\n{"head":"b"}\n`);
    expect(entries.map((entry) => entry.head)).toEqual(["a", "b"]);
  });
});
