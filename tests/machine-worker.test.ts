import { mkdtemp, chmod, lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { initializeIdentity, readIdentity, readTicket, serverSchema } from "../src/worker/identity";
import { probeCapability, probeDirectory } from "../src/worker/probes";
import { ID_PREFIXES, newId } from "../src/contracts/ids";
import { randomUUID } from "node:crypto";

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
    expect(serverSchema.safeParse(origin).success).toBe(false);
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
    expect(capability.remoteOperations).toBe("not_implemented");
    expect(capability.shells.some((shell) => shell.probe.kind === "success")).toBe(true);
  }
});
