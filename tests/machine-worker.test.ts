import { mkdtemp, chmod, lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { initializeIdentity, readIdentity, readTicket, serverSchema } from "../src/worker/identity";
import { probeCapability, probeDirectory } from "../src/worker/probes";
import { ID_PREFIXES, newId } from "../src/contracts/ids";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";

test("private Worker identity survives retries and refuses corruption, replacement and unsafe ticket files", async () => {
  const root = await mkdtemp(join(tmpdir(), "sprout-worker-state-"));
  const directory = join(root, "state");
  const machineId = newId(ID_PREFIXES.machine);
  const identity = await initializeIdentity(directory, "http://127.0.0.1:3000", machineId);
  expect(
    JSON.stringify(await initializeIdentity(directory, identity.server, machineId)) ===
      JSON.stringify(identity),
  ).toBe(true);
  expect((await lstat(directory)).mode & 0o777).toBe(0o700);
  expect((await lstat(join(directory, "identity.json"))).mode & 0o777).toBe(0o600);
  await expect(
    initializeIdentity(directory, identity.server, newId(ID_PREFIXES.machine)),
  ).rejects.toThrow();
  const saved = await readFile(join(directory, "identity.json"), "utf8");
  await writeFile(join(directory, "identity.json"), "corrupt");
  await expect(initializeIdentity(directory, identity.server, machineId)).rejects.toThrow();
  expect(await readFile(join(directory, "identity.json"), "utf8")).toBe("corrupt");
  await writeFile(join(directory, "identity.json"), saved);
  await chmod(join(directory, "identity.json"), 0o644);
  await expect(readIdentity(directory)).rejects.toThrow();
  const ticketPath = join(root, "ticket");
  await writeFile(ticketPath, "a".repeat(43), { mode: 0o600 });
  expect(await readTicket(ticketPath)).toBe("a".repeat(43));
  await chmod(ticketPath, 0o644);
  await expect(readTicket(ticketPath)).rejects.toThrow();
  for (const origin of [
    "http://example.com",
    "https://user:password@example.com",
    "https://example.com/path",
    "https://example.com/?secret=bad",
  ])
    expect(serverSchema().safeParse(origin).success).toBe(false);
});

test.each([
  { server: "http://example.com", allowed: [], accepted: false },
  { server: "http://example.com", allowed: ["http://example.com"], accepted: true },
  { server: "HTTP://EXAMPLE.COM:80/", allowed: ["http://example.com"], accepted: true },
  { server: "http://192.168.1.10:3210", allowed: ["http://192.168.1.10:3210"], accepted: true },
  { server: "http://192.168.1.11:3210", allowed: ["http://192.168.1.10:3210"], accepted: false },
  { server: "http://192.168.1.10:3211", allowed: ["http://192.168.1.10:3210"], accepted: false },
  { server: "http://example.com.evil.test", allowed: ["http://example.com"], accepted: false },
  { server: "https://example.com", allowed: [], accepted: true },
  { server: "http://localhost:3210", allowed: [], accepted: true },
  { server: "http://127.0.0.1:3210", allowed: [], accepted: true },
  { server: "http://[::1]:3210", allowed: [], accepted: true },
  { server: "http://user@example.com", allowed: ["http://example.com"], accepted: false },
  { server: "http://example.com/path", allowed: ["http://example.com"], accepted: false },
  { server: "http://example.com/?secret=bad", allowed: ["http://example.com"], accepted: false },
  { server: "http://example.com/#fragment", allowed: ["http://example.com"], accepted: false },
  { server: "not-an-origin", allowed: [], accepted: false },
  { server: "http://*.example.com", allowed: ["http://*.example.com"], accepted: false },
  { server: "ftp://example.com", allowed: [], accepted: false },
  { server: "http://example.com", allowed: ["http://*.example.com"], accepted: false },
  { server: "http://example.com", allowed: ["http://example.com/path"], accepted: false },
  { server: "http://example.com", allowed: ["https://example.com"], accepted: false },
])(
  "Worker origin authorization: $server with $allowed => $accepted",
  ({ server, allowed, accepted }) => {
    expect(serverSchema(allowed).safeParse(server).success).toBe(accepted);
  },
);

test("HTTP authorization persists and run refuses an identity without matching authorization", async () => {
  const root = await mkdtemp(join(tmpdir(), "sprout-worker-http-"));
  const directory = join(root, "state");
  const server = "http://192.168.1.10:3210";
  const machineId = newId(ID_PREFIXES.machine);
  await expect(initializeIdentity(directory, server, machineId)).rejects.toThrow(/--allow-http/);
  const identity = await initializeIdentity(directory, server, machineId, [server]);
  expect((await readIdentity(directory)).allowHttpOrigins).toEqual([server]);
  expect((await readIdentity(directory)).server).toBe(server);
  const path = join(directory, "identity.json");
  await writeFile(path, JSON.stringify({ ...identity, server: "http://192.168.1.11:3210" }));
  await expect(readIdentity(directory)).rejects.toThrow(/--allow-http/);
  const { allowHttpOrigins: _authorization, ...withoutAuthorization } = identity;
  await writeFile(path, JSON.stringify(withoutAuthorization));
  await expect(readIdentity(directory)).rejects.toThrow(/--allow-http/);
  await writeFile(
    path,
    JSON.stringify({ ...withoutAuthorization, server: "http://localhost:3210" }),
  );
  expect((await readIdentity(directory)).allowHttpOrigins).toEqual([]);
});

test("directory facts resolve links and distinguish missing paths and files without creating paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "sprout-worker-probe-"));
  const directory = join(root, "directory");
  await mkdir(directory);
  await symlink(directory, join(root, "link"));
  await writeFile(join(root, "file"), "data");
  const session = {
    machineId: newId(ID_PREFIXES.machine),
    generation: 1,
    bootId: newId(ID_PREFIXES.boot),
    attemptId: randomUUID(),
  };
  const projectId = newId(ID_PREFIXES.project);
  await symlink(directory, join(root, projectId));
  const checkedAt = "2026-01-01T00:00:00Z";
  const observed = await probeDirectory(root, projectId, 3, session, 1, checkedAt);
  expect(observed.result.kind).toBe("accessible");
  expect(observed.revision).toBe(3);
  expect(observed.projectId).toBe(projectId);
  expect((await probeDirectory(root, "file", 3, session, 1, checkedAt)).result).toEqual({
    kind: "unavailable",
    reason: "not_directory",
  });
  expect((await probeDirectory(root, "missing", 3, session, 1, checkedAt)).result).toEqual({
    kind: "unavailable",
    reason: "missing",
  });
  await expect(lstat(join(root, "missing"))).rejects.toThrow();
  if (process.platform === "darwin") {
    const capability = await probeCapability(checkedAt);
    const shellAvailable = capability.shells.some((shell) => shell.probe.kind === "success");
    expect(shellAvailable).toBe(true);
    expect(capability.remoteOperations).toEqual([
      ...(shellAvailable ? (["shell"] as const) : []),
      "file_read",
      "file_write",
      "process_list",
      "process_signal",
    ]);
  }
});

test("capability advertises no shell kind when every shell probe fails", async () => {
  if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) return;
  // 用真实沙箱阻断 /bin 下所有 shell 的执行，让 probeCapability 自己得出失败结论；
  // 不改 Worker 实现，也不在断言里硬编码映射表。
  const profile = join(await mkdtemp(join(tmpdir(), "sprout-worker-noshell-")), "deny-shell.sb");
  await writeFile(profile, '(version 1)\n(allow default)\n(deny process-exec (subpath "/bin"))\n');
  const script = join(tmpdir(), `sprout-probe-noshell-${randomUUID()}.mjs`);
  await writeFile(
    script,
    `import { probeCapability } from ${JSON.stringify(
      fileURLToPath(new URL("../src/worker/probes.ts", import.meta.url)),
    )};\n` +
      `const capability = await probeCapability("2026-01-01T00:00:00Z");\n` +
      "process.stdout.write(JSON.stringify(capability));\n",
  );
  let child;
  try {
    child = spawnSync(
      "sandbox-exec",
      ["-f", profile, process.execPath, "--import", "tsx", script],
      {
        encoding: "utf8",
        timeout: 60000,
      },
    );
  } finally {
    await unlink(script).catch(() => undefined);
  }
  expect(child.status, child.stderr + child.stdout).toBe(0);
  const capability = JSON.parse(child.stdout);
  expect(capability.shells.length).toBeGreaterThan(0);
  expect(
    capability.shells.every((shell: { probe: { kind: string } }) => shell.probe.kind !== "success"),
  ).toBe(true);
  expect(capability.remoteOperations).not.toContain("shell");
  expect(capability.remoteOperations).toEqual([
    "file_read",
    "file_write",
    "process_list",
    "process_signal",
  ]);
});
