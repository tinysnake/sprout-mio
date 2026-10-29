import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";

const roots: string[] = [];
const processes = new Set<number>();
afterEach(() => {
  for (const pid of processes) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  processes.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "verify-sandbox-")));
  roots.push(root);
  const put = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  for (const path of ["sandbox.mjs", "lib/sandbox.mjs", "prepare.mjs"]) {
    const target = join(root, "scripts/verify", path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(resolve("scripts/verify", path), target);
  }
  put(".gitignore", ".verify/\nnode_modules/\n.output/\ndist/\n");
  put("src/server/runtime.ts", "committed source");
  put("src/routeTree.gen.ts", "generated source");
  put("drizzle/0000.sql", "committed migration\n");
  put("drizzle/meta/_journal.json", "{}\n");
  put("package.json", "{}");
  put("pnpm-lock.yaml", "initial lock");
  put("node_modules/pkg/index.js", "original package");
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  };
  git("init", "-q");
  git("add", ".");
  git(
    "-c",
    "user.name=Sandbox test",
    "-c",
    "user.email=sandbox@example.test",
    "commit",
    "-qm",
    "fixture",
  );
  const gate = (code: string) =>
    put(
      "scripts/verify/probe.sh",
      `#!/usr/bin/env bash\nset -eu\ncd "$(cd "$(dirname "$0")/../.." && pwd)"\nnode --input-type=module <<'JS'\n${code}\nJS\n`,
    );
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    SPROUT_VERIFY_PREPARED_ONLY: "1",
    SPROUT_VERIFY_RUN_DIR: join(root, ".verify/runs/foreign"),
  };
  const args = [
    "scripts/verify/sandbox.mjs",
    "--gate",
    "d-runtime",
    "--",
    "scripts/verify/probe.sh",
  ];
  const invoke = () =>
    spawnSync(process.execPath, args, {
      cwd: root,
      env: environment,
      encoding: "utf8",
      timeout: 15_000,
    });
  const clean = () => expect(readdirSync(join(root, ".verify/sandboxes"))).toEqual([]);
  return { root, put, git, gate, invoke, clean, environment, args };
}

const imports = `
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, realpathSync, lstatSync} from 'node:fs';
import {join, resolve, relative} from 'node:path';
`;

test("dirty source, generated files, dependencies, caches and build outputs are private", () => {
  const f = fixture();
  f.put("src/server/runtime.ts", "dirty working source");
  f.put(".env.local", "PRIVATE_CURRENT_BYTES=true\n");
  f.put(".output/server/index.mjs", "parent production output");
  f.put("node_modules/.cache/parent", "parent cache");
  f.put("node_modules/.bin/tool", `#!/bin/sh\nexport NODE_PATH='${f.root}/node_modules/pkg'\n`);
  symlinkSync(join(f.root, "node_modules/.cache"), join(f.root, "node_modules/.vite"));
  symlinkSync(join(f.root, "src/server/runtime.ts"), join(f.root, "src/current.ts"));
  f.gate(`${imports}
const root = process.cwd();
assert.equal(readFileSync('src/server/runtime.ts', 'utf8'), 'dirty working source');
assert.equal(readFileSync('.env.local', 'utf8'), 'PRIVATE_CURRENT_BYTES=true\\n');
assert.equal(readFileSync('src/routeTree.gen.ts', 'utf8'), 'generated source');
assert(lstatSync('node_modules').isDirectory());
assert.equal(readFileSync('node_modules/.bin/tool', 'utf8').match(/NODE_PATH='([^']+)'/)[1], join(root, 'node_modules/pkg'));
for (const file of ['src/server/runtime.ts', 'src/current.ts', 'src/routeTree.gen.ts', 'node_modules/pkg/index.js', '.output/server/index.mjs']) writeFileSync(file, 'private edit');
for (const dir of ['node_modules/.vite', 'node_modules/.cache']) {
  assert(realpathSync(dir).startsWith(root + '/'));
  writeFileSync(join(dir, 'private'), 'cache');
}
for (const key of ['DATABASE_URL','SPROUT_PI_DATA_DIR','SPROUT_REPO_DIR','XDG_CACHE_HOME','PI_CODING_AGENT_DIR']) assert(process.env[key].startsWith(root + '/'), key);
mkdirSync('.verify/d-runtime/nested', {recursive:true});
writeFileSync('.verify/d-runtime/evidence.json', JSON.stringify({currentSource:true}));
writeFileSync('.verify/d-runtime/nested/browser.png', 'screenshot');
writeFileSync('.verify/d-runtime/runtime.sqlite', 'private db');
writeFileSync('.verify/d-runtime/.env', 'private environment');
writeFileSync('.verify/d-runtime/identity.json', 'private identity');
console.log('PASS private snapshot');
`);
  const result = f.invoke();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(readFileSync(join(f.root, "src/server/runtime.ts"), "utf8")).toBe("dirty working source");
  expect(readFileSync(join(f.root, "src/routeTree.gen.ts"), "utf8")).toBe("generated source");
  expect(readFileSync(join(f.root, "node_modules/pkg/index.js"), "utf8")).toBe("original package");
  expect(readFileSync(join(f.root, ".output/server/index.mjs"), "utf8")).toBe(
    "parent production output",
  );
  expect(readdirSync(join(f.root, "node_modules/.cache"))).toEqual(["parent"]);
  const artifacts = join(f.root, ".verify/d-runtime");
  expect(JSON.parse(readFileSync(join(artifacts, "evidence.json"), "utf8"))).toEqual({
    currentSource: true,
  });
  expect(readFileSync(join(artifacts, "nested/browser.png"), "utf8")).toBe("screenshot");
  for (const name of ["runtime.sqlite", ".env", "identity.json"])
    expect(existsSync(join(artifacts, name))).toBe(false);
  f.clean();
});

test.each(["package-link", "modules-link"])(
  "%s dependencies are materialized before writes or destructive installation",
  (shape) => {
    const f = fixture();
    const external = realpathSync(mkdtempSync(join(tmpdir(), "sandbox-shared-dependencies-")));
    roots.push(external);
    mkdirSync(join(external, "pkg"));
    writeFileSync(join(external, "pkg/index.js"), "external package");
    rmSync(join(f.root, "node_modules"), { recursive: true });
    if (shape === "modules-link") symlinkSync(external, join(f.root, "node_modules"));
    else {
      mkdirSync(join(f.root, "node_modules"));
      symlinkSync(
        relative(join(f.root, "node_modules"), join(external, "pkg")),
        join(f.root, "node_modules/pkg"),
      );
    }
    f.gate(`${imports}
assert(lstatSync('node_modules').isDirectory());
assert.equal(readFileSync('node_modules/pkg/index.js', 'utf8'), 'external package');
assert(realpathSync('node_modules/pkg').startsWith(process.cwd() + '/'));
writeFileSync('node_modules/pkg/index.js', 'private edit');
rmSync('node_modules', {recursive:true, force:true});
`);
    const result = f.invoke();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(readFileSync(join(external, "pkg/index.js"), "utf8")).toBe("external package");
    expect(readFileSync(join(f.root, "node_modules/pkg/index.js"), "utf8")).toBe(
      "external package",
    );
    f.clean();
  },
);

test("real preparation owns a live private context, reuses its receipts and can delete its installation", () => {
  const f = fixture();
  f.put(
    "bin/pnpm",
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const outputs = process.argv[2] === 'install' ? ['node_modules/new-package/index.js'] : ['.output/server/index.mjs','.output/public/_shell.html','.output/public/assets/client.js'];
fs.appendFileSync('calls', process.argv[2] + '\\n');
for (const output of outputs) {fs.mkdirSync(path.dirname(output), {recursive:true});fs.writeFileSync(output, 'produced privately');}
console.log('actual private producer ' + process.argv[2]);
`,
  );
  chmodSync(join(f.root, "bin/pnpm"), 0o755);
  f.environment.PATH = `${join(f.root, "bin")}:${process.env.PATH}`;
  f.gate(`${imports}
import {spawnSync} from 'node:child_process';
const context = JSON.parse(readFileSync(join(process.env.SPROUT_VERIFY_RUN_DIR, 'context.json'), 'utf8'));
assert.equal(context.root, process.cwd());
process.kill(context.ownerPid, 0);
assert.equal(existsSync(join(process.env.SPROUT_VERIFY_RUN_DIR, 'server.json')), false);
for (const args of [['install'], ['server'], ['server'], ['server', '--fresh']]) {
  const result = spawnSync(process.execPath, ['scripts/verify/prepare.mjs', ...args], {encoding:'utf8'});
  assert.equal(result.status, 0, result.stdout + result.stderr);
  console.log(result.stdout);
}
assert.equal(readFileSync('calls', 'utf8'), 'install\\nbuild\\nbuild\\n');
assert(!existsSync('node_modules/pkg/index.js'));
assert(existsSync('node_modules/new-package/index.js'));
`);
  const result = f.invoke();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain("REUSE server");
  expect(readFileSync(join(f.root, "node_modules/pkg/index.js"), "utf8")).toBe("original package");
  expect(existsSync(join(f.root, "calls"))).toBe(false);
  expect(existsSync(join(f.root, ".output"))).toBe(false);
  const receipt = JSON.parse(
    readFileSync(join(f.root, ".verify/d-runtime/sandbox-artifacts.json"), "utf8"),
  );
  expect(receipt.files.filter((path: string) => path.startsWith("preparation/")).length).toBe(3);
  f.clean();
});

test.each(["clean", "staged-and-dirty", "split-index"])(
  "git sees private migration drift against the original %s index",
  (condition) => {
    const f = fixture();
    if (condition === "staged-and-dirty") {
      f.put("drizzle/0000.sql", "staged migration\n");
      f.git("add", "drizzle/0000.sql");
      f.put("drizzle/0000.sql", "unstaged migration\n");
      f.put("drizzle/0001.sql", "untracked migration\n");
    }
    if (condition === "split-index") f.git("update-index", "--split-index");
    const before = f.git("status", "--porcelain", "--", "drizzle");
    const originalIndex = readFileSync(join(f.root, ".git/index"));
    f.gate(`${imports}
import {spawnSync} from 'node:child_process';
const status = () => {const result = spawnSync('git', ['status', '--porcelain', '--', 'drizzle'], {encoding:'utf8'});assert.equal(result.status, 0, result.stderr);return result.stdout;};
assert.equal(status(), ${JSON.stringify(before)});
writeFileSync('drizzle/0099.sql', 'private migration');
writeFileSync('drizzle/meta/_journal.json', '{"drift":true}');
const after = status();
assert(after.includes('?? drizzle/0099.sql'), after);
assert(after.includes(' M drizzle/meta/_journal.json'), after);
console.log('PASS migration drift detected privately');
`);
    const result = f.invoke();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(readFileSync(join(f.root, ".git/index"))).toEqual(originalIndex);
    expect(f.git("status", "--porcelain", "--", "drizzle")).toBe(before);
    expect(existsSync(join(f.root, "drizzle/0099.sql"))).toBe(false);
    f.clean();
  },
);

test("b-tooling can initialize and commit in nested fixture repos without inherited Git mappings", () => {
  const f = fixture();
  f.args[2] = "b-tooling";
  f.put("src/server/runtime.ts", "dirty tooling source");
  f.put("drizzle/deleted.sql", "staged then deleted");
  f.git("add", "drizzle/deleted.sql");
  rmSync(join(f.root, "drizzle/deleted.sql"));
  const before = f.git("status", "--porcelain", "--", "drizzle");
  const sourceHead = f.git("rev-parse", "HEAD");
  const sourceConfig = readFileSync(join(f.root, ".git/config"));
  f.gate(`${imports}
import {spawnSync} from 'node:child_process';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
assert.equal(process.env.SPROUT_VERIFY_PREPARED_ONLY, '0');
assert.equal(readFileSync('src/server/runtime.ts', 'utf8'), 'dirty tooling source');
assert(!existsSync('drizzle/deleted.sql'));
for (const key of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE']) assert.equal(process.env[key], undefined);
const command = (cwd, args) => {const result = spawnSync('git', args, {cwd, encoding:'utf8'});assert.equal(result.status, 0, result.stderr);return result.stdout;};
assert.equal(command(process.cwd(), ['status', '--porcelain', '--', 'drizzle']), ${JSON.stringify(before)});
assert(lstatSync('.git').isDirectory());
command(process.cwd(), ['config', '--local', 'sandbox.fixture', 'private']);
command(process.cwd(), ['update-ref', 'refs/heads/sandbox-proof', 'HEAD']);
const temporary = mkdtempSync(join(tmpdir(), 'sandbox-nested-git-'));
try {
  command(temporary, ['init', '-q']);
  writeFileSync(join(temporary, 'fixture'), 'nested source');
  command(temporary, ['add', '.']);
  command(temporary, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'nested fixture']);
  assert.notEqual(command(temporary, ['rev-parse', 'HEAD']), ${JSON.stringify(sourceHead)});
  assert.equal(command(process.cwd(), ['rev-parse', 'HEAD']), ${JSON.stringify(sourceHead)});
} finally { rmSync(temporary, {recursive:true, force:true}); }
`);
  const result = f.invoke();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(f.git("rev-parse", "HEAD")).toBe(sourceHead);
  expect(readFileSync(join(f.root, ".git/config"))).toEqual(sourceConfig);
  expect(existsSync(join(f.root, ".git/refs/heads/sandbox-proof"))).toBe(false);
  expect(f.git("status", "--porcelain", "--", "drizzle")).toBe(before);
  f.clean();
});

function alive(pid: number) {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" });
  return result.status === 0 && !result.stdout.trim().startsWith("Z");
}

test.each([0, 17, "SIGTERM"])(
  "exit %s removes orphan descendants and workspace while preserving the outcome",
  (outcome) => {
    const f = fixture();
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    processes.add(unrelated.pid!);
    f.gate(`
import {spawn} from 'node:child_process';
const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {detached:true, stdio:'ignore'});
child.unref();
console.log('CHILD ' + child.pid);
${typeof outcome === "number" ? `process.exit(${outcome});` : "process.kill(process.pid, 'SIGTERM');"}
`);
    const result = f.invoke();
    const pid = Number(result.stdout.match(/CHILD (\d+)/)?.[1]);
    processes.add(pid);
    expect(pid, result.stdout + result.stderr).toBeGreaterThan(0);
    if (typeof outcome === "number") expect(result.status, result.stderr).toBe(outcome);
    else expect(result.status).toBe(143);
    expect(alive(pid)).toBe(false);
    processes.delete(pid);
    expect(alive(unrelated.pid!)).toBe(true);
    f.clean();
  },
);

test("process group interruption forwards SIGTERM and cleans detached live descendants", async () => {
  const f = fixture();
  f.gate(`
import {spawn} from 'node:child_process';
const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('READY ' + process.pid); setInterval(() => {}, 1000)"], {detached:true, stdio:['ignore','pipe','ignore']});
child.stdout.on('data', bytes => process.stdout.write(bytes));
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`);
  const launcher = spawn(process.execPath, f.args, {
    cwd: f.root,
    env: f.environment,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  processes.add(launcher.pid!);
  let output = "";
  let descendant = 0;
  const result = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveResult, reject) => {
      const deadline = setTimeout(
        () => reject(new Error(`sandbox interruption timed out: ${output}`)),
        10_000,
      );
      launcher.stdout.on("data", (bytes) => {
        output += bytes;
        if (!descendant) {
          descendant = Number(output.match(/READY (\d+)/)?.[1]) || 0;
          if (descendant) {
            processes.add(descendant);
            process.kill(-launcher.pid!, "SIGTERM");
          }
        }
      });
      launcher.stderr.on("data", (bytes) => {
        output += bytes;
      });
      launcher.once("error", reject);
      launcher.once("close", (code, signal) => {
        clearTimeout(deadline);
        resolveResult({ code, signal });
      });
    },
  );
  expect(await result, output).toEqual({ code: null, signal: "SIGTERM" });
  expect(descendant).toBeGreaterThan(0);
  expect(alive(descendant)).toBe(false);
  processes.delete(descendant);
  processes.delete(launcher.pid!);
  f.clean();
});
