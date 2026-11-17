import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { expect, it } from "vite-plus/test";

it("observes role prompts and delegation tools in actual provider requests, including resume", async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--import", "tsx", resolve("tests/fixtures/agent-prompt-runner.ts")],
    { timeout: 120000, maxBuffer: 1024 * 1024 },
  );
  expect(stdout).toContain(
    "agent prompt runner: initial surfaces and every deferred tool discovery PASS; paidModelCalls=0",
  );
}, 130000);
