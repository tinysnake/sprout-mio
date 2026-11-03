import { describe, expect, it } from "vite-plus/test";
import { formatCurrentTime, registerCurrentTimeTool } from "../src/extension/time-tools";
import type { SproutExtensionAPI } from "../src/extension/types";

describe("current_time", () => {
  it("formats UTC, Shanghai, and New York with the correct offset and weekday", () => {
    const instant = new Date("2026-11-04T00:15:30.123Z");
    expect(formatCurrentTime("UTC", instant)).toMatchObject({
      iso: "2026-11-04T00:15:30.123+00:00",
      utc: "2026-11-04T00:15:30.123Z",
      epochMs: instant.getTime(),
      offset: "+00:00",
      weekday: "Wednesday",
    });
    expect(formatCurrentTime("Asia/Shanghai", instant)).toMatchObject({
      iso: "2026-11-04T08:15:30.123+08:00",
      offset: "+08:00",
      weekday: "Wednesday",
    });
    expect(formatCurrentTime("America/New_York", instant)).toMatchObject({
      iso: "2026-11-03T19:15:30.123-05:00",
      offset: "-05:00",
      weekday: "Tuesday",
    });
  });

  it("registers a tool that rejects an invalid IANA timezone", async () => {
    let registered: Parameters<SproutExtensionAPI["registerTool"]>[0] | undefined;
    registerCurrentTimeTool({
      registerTool: (tool) => {
        registered = tool;
      },
      registerCommand: () => {},
    });
    expect(registered?.name).toBe("current_time");
    const result = await registered!.execute("probe", { timezone: "Not/AZone" });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text" });
  });

  it("uses the host timezone when timezone is omitted", async () => {
    let registered: Parameters<SproutExtensionAPI["registerTool"]>[0] | undefined;
    registerCurrentTimeTool({
      registerTool: (tool) => {
        registered = tool;
      },
      registerCommand: () => {},
    });
    const result = await registered!.execute("probe", {});
    expect(result.isError).toBeUndefined();
    expect(result.details).toMatchObject({
      timezone: expect.any(String),
      iso: expect.any(String),
      utc: expect.any(String),
    });
  });
});
