import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const fixtures = {
  authority: "tests/fixtures/p4d-acceptance-authority.ts",
  migration: "tests/fixtures/p4d-acceptance-migration.ts",
};
const mode = process.argv[2];
if (!Object.hasOwn(fixtures, mode))
  throw new Error("usage: node scripts/verify/p4d-acceptance.mjs authority|migration");
const directory = mkdtempSync(join(tmpdir(), "p4d-acceptance-"));
try {
  const result = spawnSync(process.execPath, ["--import", "tsx", fixtures[mode]], {
    cwd: resolve(import.meta.dirname, "../.."),
    stdio: "inherit",
    timeout: 60000,
    env: {
      ...process.env,
      NODE_ENV: "test",
      SPROUT_PI_ENABLED: "false",
      BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
      DATABASE_URL: join(directory, "acceptance.sqlite"),
    },
  });
  if (result.error) console.error(result.error);
  process.exitCode = result.status ?? 124;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
