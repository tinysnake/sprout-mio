import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cases } from "./checks.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const dry = process.env.AB_DRY ?? "1";
assert(["0", "1"].includes(dry), "AB_DRY must be 0 or 1");
const refs = process.env.AB_REF
  ? [process.env.AB_REF]
  : [process.env.AB_REF_A, process.env.AB_REF_B];
assert(refs.every(Boolean), "Set AB_REF, or both AB_REF_A and AB_REF_B");
assert(existsSync(join(root, "node_modules")), "Run pnpm install --frozen-lockfile first");
const base = resolve(process.env.AB_OUT ?? join(root, ".verify/assistant-guide-ab"));
mkdirSync(base, { recursive: true });
const output = mkdtempSync(join(base, "run-"));
console.log(`EVIDENCE ${output}`);
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 30000 }).trim();
const manifest = { mode: dry === "1" ? "local-model-fixture" : "paid-live", cases, arms: [] };
async function command(program, args, cwd, env, log, timeout = 300000) {
  const started = Date.now();
  const fd = openSync(log, "w");
  const child = spawn(program, args, { cwd, env, detached: true, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  let expired = false;
  const kill = (signal) => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  let escalation;
  const timer = setTimeout(() => {
    expired = true;
    kill("SIGTERM");
    escalation = setTimeout(() => kill("SIGKILL"), 2000);
  }, timeout);
  const signalHandler = () => kill("SIGTERM");
  process.once("SIGTERM", signalHandler);
  process.once("SIGINT", signalHandler);
  try {
    const code = await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("exit", done);
    });
    const elapsedMs = Date.now() - started;
    writeFileSync(`${log}.exit.json`, JSON.stringify({ code, expired, elapsedMs }));
    assert(
      !expired && code === 0,
      `${program} exit=${code} timeout=${expired}; ${log}:1\n${readFileSync(log, "utf8").slice(-12000)}`,
    );
    return elapsedMs;
  } finally {
    clearTimeout(timer);
    clearTimeout(escalation);
    process.removeListener("SIGTERM", signalHandler);
    process.removeListener("SIGINT", signalHandler);
  }
}
let failed = false;
for (const [index, ref] of refs.entries()) {
  const arm = join(output, `arm-${index + 1}`);
  mkdirSync(arm);
  const head = git("rev-parse", "--verify", `${ref}^{commit}`);
  const row = { ref, head, directory: arm, status: "FAIL" };
  manifest.arms.push(row);
  const temp = mkdtempSync(join(tmpdir(), "assistant-guide-ab-"));
  const checkout = join(temp, "checkout");
  mkdirSync(checkout);
  try {
    for (const file of ["package.json", "pnpm-lock.yaml"])
      assert.equal(
        git("show", `${head}:${file}`),
        readFileSync(join(root, file), "utf8").trim(),
        `${file} differs; install matching dependencies before comparing refs`,
      );
    await command(
      "git",
      ["archive", "--format=tar", `--output=${join(temp, "ref.tar")}`, head],
      root,
      process.env,
      join(arm, "archive.log"),
    );
    await command(
      "tar",
      ["-xf", join(temp, "ref.tar"), "-C", checkout],
      root,
      process.env,
      join(arm, "extract.log"),
    );
    symlinkSync(join(root, "node_modules"), join(checkout, "node_modules"), "dir");
    cpSync(
      fileURLToPath(new URL(".", import.meta.url)),
      join(checkout, "scripts/verify-live/assistant-guide-ab"),
      { recursive: true },
    );
    // 仅覆盖检查器；runner、extension、domain、theme 均来自被测 ref。
    const env = {
      ...process.env,
      AB_DRY: dry,
      ASSISTANT_AB_DIR: arm,
      SPROUT_PI_RUNNER: join(checkout, "scripts/pi-host-runner.mjs"),
    };
    delete env.SPROUT_VERIFY_RUN_DIR;
    await command(
      "pnpm",
      ["exec", "tsx", "scripts/verify-live/assistant-guide-ab/driver.ts"],
      checkout,
      env,
      join(arm, "driver.log"),
      Number(process.env.AB_TIMEOUT_MS ?? 480000),
    );
    row.status = "PASS";
    console.log(
      readFileSync(join(arm, "driver.log"), "utf8")
        .split("\n")
        .filter((line) => /^(PASS|FAIL) /.test(line))
        .join("\n"),
    );
    console.log(`PASS ref=${ref} head=${head} mode=${manifest.mode}`);
  } catch (error) {
    failed = true;
    console.error(`FAIL ref=${ref} ${arm}/driver.log:1 ${error.message}`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
writeFileSync(join(output, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`${failed ? "FAIL" : "PASS"} assistant guide comparison ${output}/manifest.json`);
if (failed) process.exitCode = 1;
