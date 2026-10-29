import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";

test("缺入网凭据的机器在列表里保持未配对，重新登记给出域错误而不是 internal", () => {
  const directory = mkdtempSync(join(tmpdir(), "sprout-machine-credential-gap-"));
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", "tests/fixtures/machine-credential-gap.ts"],
    {
      env: { ...process.env, DATABASE_URL: join(directory, "machine.sqlite") },
      encoding: "utf8",
      timeout: 60000,
    },
  );
  expect(child.status, child.stderr + child.stdout).toBe(0);
  expect(child.stdout).toContain("PASS credential gap lists machine as pending");
  expect(child.stdout).toContain("PASS credential gap rejects re-enrollment with a domain error");
});
