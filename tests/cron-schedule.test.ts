import { describe, expect, it } from "vite-plus/test";
import { nextCronOccurrence } from "../src/domain/cron-schedule";
const next = (expression: string, at: string, timezone = "UTC") =>
  nextCronOccurrence({ expression, timezone }, new Date(at)).toISOString();

describe("five-field cron calendar boundary", () => {
  it("rejects parser extensions, impossible dates and implicit/invalid timezones", () => {
    for (const expression of [
      "* * * * * *",
      "@daily",
      "0 9 * JAN MON",
      "0 9 L * *",
      "0 9 ? * 1",
      "60 * * * *",
      "0 0 31 2 *",
    ])
      expect(() => next(expression, "2026-01-01T00:00:00Z")).toThrow();
    for (const timezone of ["", "Mars/Olympus", "+08:00"])
      expect(() => next("* * * * *", "2026-01-01T00:00:00Z", timezone)).toThrow();
  });
  it("is strictly after, uses numeric lists/ranges/steps and DOM/DOW OR", () => {
    expect(next("0,30 9-17/2 * * 0-7", "2026-01-01T09:00:00Z")).toBe("2026-01-01T09:30:00.000Z");
    expect(next("0 9 15 * 1", "2026-01-01T00:00:00Z")).toBe("2026-01-05T09:00:00.000Z");
    expect(next("0 0 29 2 *", "2096-03-01T00:00:00Z")).toBe("2104-02-29T00:00:00.000Z");
  });
  it("locks pinned parser DST: spring gap shifts, repeated autumn hour fires once", () => {
    expect(next("30 2 * * *", "2026-03-08T05:00:00Z", "America/New_York")).toBe(
      "2026-03-08T07:30:00.000Z",
    );
    expect(next("30 1 * * *", "2026-11-01T04:00:00Z", "America/New_York")).toBe(
      "2026-11-01T05:30:00.000Z",
    );
    expect(next("30 1 * * *", "2026-11-01T05:30:00Z", "America/New_York")).toBe(
      "2026-11-02T06:30:00.000Z",
    );
  });
});
