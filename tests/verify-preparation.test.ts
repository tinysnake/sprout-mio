import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    const producerPath = join(root, "natural-producer-pid");
    if (existsSync(producerPath)) {
      try {
        process.kill(-Number(readFileSync(producerPath, "utf8")), "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "verify-preparation-")));
  roots.push(root);
  const put = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  mkdirSync(join(root, "scripts/verify"), { recursive: true });
  copyFileSync(resolve("scripts/verify/prepare.mjs"), join(root, "scripts/verify/prepare.mjs"));
  put("src/main.ts", "initial source");
  put("package.json", "{}");
  put("pnpm-lock.yaml", "initial lock");
  put(
    "bin/pnpm",
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const kind = ({build:'server', 'worker:build':'worker', 'extension:build':'extension', install:'install'})[process.argv[2]];
fs.appendFileSync('calls', kind + '\\n');
console.log('raw producer evidence ' + kind);
fs.writeFileSync('producer-env', JSON.stringify({nodeEnv:process.env.NODE_ENV, secretPresent:'BETTER_AUTH_SECRET' in process.env, nodeOptions:process.env.NODE_OPTIONS}));
if (process.env.FAKE_FAIL === 'signal') process.kill(process.pid, 'SIGKILL');
else if (process.env.FAKE_FAIL) process.exit(17);
if (process.env.FAKE_BLOCK) {
  if (process.env.FAKE_TRAP_EXIT_ZERO) process.on('SIGTERM', () => process.exit(0));
  require('node:child_process').spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync('descendant-pid', String(process.pid)); setInterval(() => {}, 1000)"], {stdio: 'ignore'});
  fs.writeFileSync('producer-pid', String(process.pid));
  setInterval(() => {}, 1000);
} else {
  const outputs = {install:['node_modules/.installed'],server:['.output/server/index.mjs','.output/public/_shell.html','.output/public/assets/client.js'],worker:['dist/worker/main.js','dist/worker/runner.js'],extension:['dist/extension/main.js']};
  for (const output of outputs[kind]) { fs.mkdirSync(path.dirname(output), {recursive:true}); fs.writeFileSync(output, 'built'); }
  if (kind === 'server') fs.writeFileSync('src/routeTree.gen.ts', 'generated routes');
  if (process.env.FAKE_BACKGROUND) {
    const background = require('node:child_process').spawn('sleep', ['30'], {stdio: 'inherit'});
    fs.writeFileSync('natural-producer-pid', String(process.pid));
    fs.writeFileSync('background-pid', String(background.pid));
    background.unref();
    console.log('natural producer finished');
    console.error('raw producer stderr evidence');
  }
}
`,
  );
  const executable = join(root, "bin/pnpm");
  spawnSync("chmod", ["+x", executable]);
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${join(root, "bin")}:${process.env.PATH}`,
  };
  delete environment.SPROUT_VERIFY_RUN_DIR;
  const run = (id: string) => {
    const directory = join(root, ".verify/runs", id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "context.json"),
      JSON.stringify({ root, runId: id, ownerPid: process.pid }),
    );
    return directory;
  };
  const firstRun = run("first");
  const invoke = (kind = "server", extra: string[] = [], env: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, ["scripts/verify/prepare.mjs", kind, ...extra], {
      cwd: root,
      env: { ...environment, SPROUT_VERIFY_RUN_DIR: firstRun, ...env },
      encoding: "utf8",
      timeout: 10_000,
    });
  const calls = () =>
    existsSync(join(root, "calls"))
      ? readFileSync(join(root, "calls"), "utf8").trim().split("\n")
      : [];
  return { root, put, run, invoke, calls, firstRun, environment };
}

test("reuses each artifact only within the living current run, and retains original log evidence", () => {
  const f = fixture();
  for (const kind of ["server", "worker", "extension"]) {
    expect(f.invoke(kind).status).toBe(0);
    const reused = f.invoke(kind);
    expect(reused.status).toBe(0);
    expect(reused.stdout).toContain(`REUSE ${kind}`);
    expect(reused.stdout).toContain(`raw producer evidence ${kind}`);
  }
  expect(f.calls()).toEqual(["server", "worker", "extension"]);
  expect(f.invoke("server", [], { SPROUT_VERIFY_RUN_DIR: f.run("next") }).status).toBe(0);
  for (let i = 0; i < 2; i++)
    expect(f.invoke("server", [], { SPROUT_VERIFY_RUN_DIR: undefined }).status).toBe(0);
  expect(f.calls().filter((kind) => kind === "server")).toHaveLength(4);
});

test("runner context connects preparation across domains without a second install deleting artifacts", () => {
  const f = fixture();
  copyFileSync(resolve("scripts/verify/runner.mjs"), join(f.root, "scripts/verify/runner.mjs"));
  for (const name of ["native-lanes.mjs", "suite-plan.mjs"])
    f.put(`scripts/verify/lib/${name}`, readFileSync(resolve("scripts/verify/lib", name), "utf8"));
  f.put(
    "scripts/verify/a-first.sh",
    "set -eu\nnode scripts/verify/prepare.mjs install\nnode scripts/verify/prepare.mjs server\nnode scripts/verify/prepare.mjs worker\nnode scripts/verify/prepare.mjs extension\n",
  );
  f.put(
    "scripts/verify/b-second.sh",
    "set -eu\nnode scripts/verify/prepare.mjs install\nnode scripts/verify/prepare.mjs server\ntest -f dist/worker/main.js\ntest -f dist/extension/main.js\n",
  );
  for (let i = 0; i < 2; i++) {
    const result = spawnSync(process.execPath, ["scripts/verify/runner.mjs"], {
      cwd: f.root,
      env: f.environment,
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  }
  expect(f.calls()).toEqual([
    "install",
    "server",
    "worker",
    "extension",
    "install",
    "server",
    "worker",
    "extension",
  ]);
});

test("source, dependencies, compiler profile and missing outputs invalidate success", () => {
  const f = fixture();
  expect(f.invoke().status).toBe(0);
  for (const [path, value] of [
    ["src/main.ts", "changed"],
    ["pnpm-lock.yaml", "new lock"],
    [".env.local", "VITE_NAME=new"],
  ]) {
    f.put(path!, value!);
    expect(f.invoke().stdout).toContain("PREPARE server");
  }
  rmSync(join(f.root, ".output/server/index.mjs"));
  expect(f.invoke().stdout).toContain("PREPARE server");
  expect(f.invoke("server", [], { VITE_PROFILE: "different" }).stdout).toContain("PREPARE server");
  expect(f.calls()).toHaveLength(6);
});

test("same-run installation preserves prepared artifacts, fresh installation invalidates them", () => {
  const f = fixture();
  expect(f.invoke("install").status).toBe(0);
  expect(f.invoke("server").status).toBe(0);
  expect(f.invoke("worker").status).toBe(0);
  expect(f.invoke("install").stdout).toContain("REUSE install");
  expect(existsSync(join(f.root, "dist/worker/main.js"))).toBe(true);
  expect(f.invoke("server").stdout).toContain("REUSE server");
  expect(f.calls()).toEqual(["install", "server", "worker"]);
  expect(f.invoke("install", ["--fresh"]).status).toBe(0);
  expect(existsSync(join(f.root, "dist/worker/main.js"))).toBe(false);
  expect(f.invoke("server").stdout).toContain("PREPARE server");
});

test("fresh builds replace the receipt while preserving both raw producer logs", () => {
  const f = fixture();
  expect(f.invoke().status).toBe(0);
  const original = JSON.parse(readFileSync(join(f.firstRun, "server.json"), "utf8"));
  expect(f.invoke("server", ["--fresh"]).stdout).toContain("PREPARE server");
  const fresh = JSON.parse(readFileSync(join(f.firstRun, "server.json"), "utf8"));
  expect(fresh.logPath).not.toBe(original.logPath);
  for (const receipt of [original, fresh])
    expect(readFileSync(receipt.logPath, "utf8")).toContain("raw producer evidence server");
  expect(f.invoke().stdout).toContain("REUSE server");
  expect(f.calls()).toEqual(["server", "server"]);
});

test.each([
  ["exit", 17],
  ["signal", 137],
] as const)(
  "%s failure during replacement cannot leave an older reusable success",
  (failure, exitCode) => {
    const f = fixture();
    expect(f.invoke().status).toBe(0);
    const failed = f.invoke("server", ["--fresh"], { FAKE_FAIL: failure });
    expect(failed.status).toBe(exitCode);
    if (failure === "signal")
      expect(failed.stderr).toContain("code=null signal=SIGKILL interrupted=null");
    expect(existsSync(join(f.firstRun, "server.json"))).toBe(false);
    expect(f.invoke().stdout).toContain("PREPARE server");
    expect(f.calls()).toHaveLength(3);
  },
);

test.each([
  ["SIGTERM", "1", 143, "code=0 signal=null interrupted=SIGTERM"],
  ["SIGINT", "", 130, "signal=SIGINT interrupted=SIGINT"],
] as const)(
  "%s interruption stops the producer and refuses success even when its trap exits zero",
  async (signal, trapExitZero, exitCode, evidence) => {
    const f = fixture();
    expect(f.invoke().status).toBe(0);
    const child = spawn(process.execPath, ["scripts/verify/prepare.mjs", "server", "--fresh"], {
      cwd: f.root,
      env: {
        ...f.environment,
        SPROUT_VERIFY_RUN_DIR: f.firstRun,
        FAKE_BLOCK: "1",
        FAKE_TRAP_EXIT_ZERO: trapExitZero,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    const completed = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
    try {
      const deadline = Date.now() + 5000;
      while (
        (!existsSync(join(f.root, "producer-pid")) ||
          !existsSync(join(f.root, "descendant-pid"))) &&
        Date.now() < deadline
      )
        await new Promise((r) => setTimeout(r, 10));
      expect(existsSync(join(f.root, "producer-pid"))).toBe(true);
      const pid = Number(readFileSync(join(f.root, "producer-pid"), "utf8"));
      const descendant = Number(readFileSync(join(f.root, "descendant-pid"), "utf8"));
      child.kill(signal);
      expect(await completed, stderr).toBe(exitCode);
      expect(stderr).toContain(evidence);
      expect(() => process.kill(pid, 0)).toThrow();
      const gone = () => {
        try {
          process.kill(descendant, 0);
          return false;
        } catch {
          return true;
        }
      };
      const cleanupDeadline = Date.now() + 2000;
      while (!gone() && Date.now() < cleanupDeadline) await new Promise((r) => setTimeout(r, 10));
      expect(gone()).toBe(true);
      expect(existsSync(join(f.firstRun, "server.json"))).toBe(false);
      expect(f.invoke().stdout).toContain("PREPARE server");
    } finally {
      child.kill("SIGTERM");
      await completed;
    }
  },
);

test("natural producer exit completes while a background descendant inherits stdio and cleans that descendant", async () => {
  const f = fixture();
  const result = spawnSync(process.execPath, ["scripts/verify/prepare.mjs", "server"], {
    cwd: f.root,
    env: { ...f.environment, SPROUT_VERIFY_RUN_DIR: f.firstRun, FAKE_BACKGROUND: "1" },
    encoding: "utf8",
    timeout: 10000,
  });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("natural producer finished");
  expect(result.stdout).toContain("raw producer stderr evidence");
  const background = Number(readFileSync(join(f.root, "background-pid"), "utf8"));
  const gone = () => {
    try {
      process.kill(background, 0);
      return false;
    } catch {
      return true;
    }
  };
  const deadline = Date.now() + 2000;
  while (!gone() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  expect(gone()).toBe(true);
  const receipt = JSON.parse(readFileSync(join(f.firstRun, "server.json"), "utf8"));
  const raw = readFileSync(receipt.logPath, "utf8");
  expect(raw).toContain("natural producer finished");
  expect(raw).toContain("raw producer stderr evidence");
  expect(f.invoke().stdout).toContain("REUSE server");
  expect(f.calls()).toEqual(["server"]);
});

test("server preparation unsets auth secret, preserves compiler settings and ignores runtime-only env", () => {
  const f = fixture();
  const env = {
    NODE_ENV: "test",
    NODE_OPTIONS: "--no-warnings",
    BETTER_AUTH_SECRET: "sensitive-value",
    DATABASE_URL: "first.sqlite",
    APP_ORIGIN: "http://first",
  };
  expect(f.invoke("server", [], env).status).toBe(0);
  expect(JSON.parse(readFileSync(join(f.root, "producer-env"), "utf8"))).toEqual({
    nodeEnv: "production",
    secretPresent: false,
    nodeOptions: "--no-warnings",
  });
  expect(
    f.invoke("server", [], {
      ...env,
      BETTER_AUTH_SECRET: "another-secret",
      DATABASE_URL: "second.sqlite",
      APP_ORIGIN: "http://second",
    }).stdout,
  ).toContain("REUSE server");
  const metadata = readdirSync(f.firstRun)
    .map((file) => readFileSync(join(f.firstRun, file), "utf8"))
    .join("\n");
  expect(metadata).not.toContain("sensitive-value");
  expect(metadata).not.toContain("another-secret");
});

test("prepared-only consumers reuse receipts and reject producers before deleting receipts or outputs", () => {
  const f = fixture();
  for (const kind of ["install", "server", "worker"]) expect(f.invoke(kind).status).toBe(0);
  const guarded = { SPROUT_VERIFY_PREPARED_ONLY: "1" };
  expect(f.invoke("server", [], guarded).stdout).toContain("REUSE server");
  const receipts = ["install", "server", "worker"].map((kind) =>
    readFileSync(join(f.firstRun, `${kind}.json`), "utf8"),
  );
  const logs = readdirSync(f.firstRun).sort();
  f.put("src/main.ts", "changed while consumers active");
  for (const [kind, option, env] of [
    ["server", [], guarded],
    ["install", ["--fresh"], guarded],
    ["worker", [], { ...guarded, NODE_ENV: "production" }],
    ["server", [], { ...guarded, SPROUT_VERIFY_RUN_DIR: undefined }],
  ] as const) {
    const result = f.invoke(kind, [...option], env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Prepared-only verification forbids producing");
  }
  expect(
    ["install", "server", "worker"].map((kind) =>
      readFileSync(join(f.firstRun, `${kind}.json`), "utf8"),
    ),
  ).toEqual(receipts);
  expect(readdirSync(f.firstRun).sort()).toEqual(logs);
  for (const path of ["node_modules/.installed", ".output/server/index.mjs", "dist/worker/main.js"])
    expect(readFileSync(join(f.root, path), "utf8")).toBe("built");
  expect(f.calls()).toEqual(["install", "server", "worker"]);
});

test("invalid internal run contexts fail clearly instead of reusing stale outputs", () => {
  const f = fixture();
  for (const context of [
    "{",
    JSON.stringify({ root: "/other", runId: "first", ownerPid: process.pid }),
    JSON.stringify({ root: f.root, runId: "first", ownerPid: 2147483647 }),
  ]) {
    writeFileSync(join(f.firstRun, "context.json"), context);
    const result = f.invoke();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Invalid verification run context");
  }
  expect(f.calls()).toEqual([]);
});
