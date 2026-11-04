import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { parseConfig } from "../src/lib/config";

describe("instance continuation switch", () => {
  it("defaults on, parses explicit values, and rejects ambiguous values", () => {
    expect(parseConfig({}).SPROUT_CONTINUATION_ENABLED).toBe(true);
    expect(parseConfig({ SPROUT_CONTINUATION_ENABLED: "true" }).SPROUT_CONTINUATION_ENABLED).toBe(
      true,
    );
    expect(parseConfig({ SPROUT_CONTINUATION_ENABLED: "false" }).SPROUT_CONTINUATION_ENABLED).toBe(
      false,
    );
    expect(() => parseConfig({ SPROUT_CONTINUATION_ENABLED: "0" })).toThrow(
      "SPROUT_CONTINUATION_ENABLED",
    );
  });

  it("blocks due and manual wake work while the enabled control evaluates and delivers", () => {
    const directory = mkdtempSync(join(tmpdir(), "deploy-continuation-off-"));
    try {
      const output = execFileSync("bash", ["scripts/verify/deploy-continuation-off.sh"], {
        env: { ...process.env, DEPLOY_CONTINUATION_EVIDENCE_DIR: directory },
        encoding: "utf8",
        timeout: 30000,
      });
      expect(output).toContain("continuation disabled by SPROUT_CONTINUATION_ENABLED=false");
      const evidence = output
        .split("\n")
        .filter((line) => line.startsWith("CONTINUATION "))
        .map((line) => JSON.parse(line.slice("CONTINUATION ".length)));
      expect(evidence).toMatchObject([
        {
          enabled: false,
          modelBoundaryCalls: 0,
          evaluations: 0,
          deliveries: 0,
          "paid-model-calls": 0,
        },
        {
          enabled: true,
          modelBoundaryCalls: 1,
          evaluations: 1,
          deliveries: 1,
          "paid-model-calls": 0,
        },
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 35000);
});
