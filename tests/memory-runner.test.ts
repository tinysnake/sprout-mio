import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { expect, it } from "vite-plus/test";

it("enforces memory isolation and failure recovery in the actual Pi runner", async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--import", "tsx", resolve("tests/fixtures/memory-runner.ts")],
    { timeout: 180000, maxBuffer: 1024 * 1024 },
  );
  expect(stdout).toContain(
    "memory runner: 9 gates PASS; paidModelCalls=0; Hindsight service calls=0",
  );
}, 190000);
