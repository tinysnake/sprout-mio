import { afterAll, expect, it } from "vite-plus/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ID_PREFIXES, newId } from "../src/contracts/ids";

/**
 * 这里的核心断言是「没有租约也能读」：审核发生在 agent 结束之后，
 * 那时不该存在活租约，读也不该因为它不存在而被拒。
 */
const directory = mkdtempSync(join(tmpdir(), "machine-browse-route-"));
process.env.DATABASE_URL = join(directory, "test.sqlite");
process.env.SPROUT_PI_DATA_DIR = join(directory, "pi");
process.env.SPROUT_PI_ENABLED = "false";
process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("base64url");
const { startRuntime, shutdownRuntime, machineRuntimeContext } =
  await import("../src/server/runtime");
await startRuntime();
const { sqlite } = await import("../src/db");
const { createProject } = await import("../src/domain/project");
const { projectWorkingPath } = await import("../src/contracts/machine");
const { listBrowseDirectory, readBrowseFileChunk } = await import("../src/worker/browse");
const {
  MachineBrowseError,
  MachineRangeError,
  mergeBrowseResults,
  openMachineFile,
  readMachineTree,
  takeBrowseCommands,
} = await import("../src/server/machine-browse");
import type { MachineBrowseResult } from "../src/contracts/machine-browse";

const owner = { userId: "machine-browse-owner", requestId: "req_machine_browse" };
sqlite
  .prepare(
    "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
  )
  .run(owner.userId, "Human", "{{EMAIL_8cn4x2dp}}");
const project = createProject({ name: "Machine" }, owner);
const machineId = newId(ID_PREFIXES.machine);
const root = join(directory, "machine-root");
const working = projectWorkingPath(root, project.id);
mkdirSync(join(working, "docs"), { recursive: true });
writeFileSync(join(working, "README.md"), "# 远端记录\n");
writeFileSync(join(working, "docs", "data.csv"), "name,value\na,1\n");
writeFileSync(join(working, "big.txt"), "0123456789".repeat(1000));
const runtime = await machineRuntimeContext();
const now = Date.now();

sqlite
  .prepare(
    "INSERT INTO machine(id,name,root_directory,root_revision,created_by,created_at,updated_at) VALUES (?,?,?,1,?,?,?)",
  )
  .run(machineId, "Builder", root, owner.userId, now, now);
sqlite
  .prepare(
    "INSERT INTO project_machine(project_id,machine_id,created_by,description,revision,created_at,updated_at) VALUES (?,?,?,?,1,?,?)",
  )
  .run(project.id, machineId, owner.userId, "", now, now);
sqlite
  .prepare(
    "INSERT INTO project_machine_membership(project_id,machine_id,epoch,state,joined_at) VALUES (?,?,1,'active',?)",
  )
  .run(project.id, machineId, now);
sqlite
  .prepare("INSERT INTO machine_connection_counter(machine_id,high_water) VALUES (?,1)")
  .run(machineId);
sqlite
  .prepare(
    "INSERT INTO machine_connection(machine_id,generation,attempt_id,boot_id,status,opened_at,last_seen_at,seq) VALUES (?,1,?,?,'open',?,?,0)",
  )
  .run(machineId, newId(ID_PREFIXES.request), runtime.bootId, now, now);
sqlite
  .prepare(
    "INSERT INTO directory_observation(machine_id,generation,project_id,revision,seq,checked_at,kind,real_path) VALUES (?,1,?,1,1,?,'accessible',?)",
  )
  .run(machineId, project.id, now, working);

/** 起一个只做读盘的「worker」：取命令、执行、回填结果，不经过网络与租约。 */
function startWorker() {
  let running = true;
  const loop = (async () => {
    while (running) {
      const commands = takeBrowseCommands(machineId, Date.now());
      if (commands.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        continue;
      }
      const results: MachineBrowseResult[] = [];
      for (const command of commands) {
        try {
          if (command.op === "dir_list")
            results.push({
              requestId: command.requestId,
              ok: true,
              op: "dir_list",
              ...(await listBrowseDirectory(root, command.projectId, command.path)),
            });
          else
            results.push({
              requestId: command.requestId,
              ok: true,
              op: "file_chunk",
              ...(await readBrowseFileChunk(root, command.projectId, command.path, {
                offset: command.offset,
                maxBytes: command.maxBytes,
              })),
            });
        } catch (error) {
          results.push({
            requestId: command.requestId,
            ok: false,
            code: (error as { code?: "not_found" }).code ?? "validation_failed",
            message: (error as Error).message,
          } as MachineBrowseResult);
        }
      }
      mergeBrowseResults(machineId, results, Date.now());
    }
  })();
  return async () => {
    running = false;
    await loop;
  };
}

const stopWorker = startWorker();

afterAll(async () => {
  await stopWorker();
  await shutdownRuntime("machine-browse-route-test");
  sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

const ctx = () => ({ ...owner, now: new Date(), bootId: runtime.bootId });

it("没有租约也能列出远端目录，条目与本机版同形", async () => {
  const leases = sqlite.prepare("SELECT count(*) AS count FROM machine_lease").get() as {
    count: number;
  };
  expect(leases.count).toBe(0);
  const tree = await readMachineTree(ctx(), { projectId: project.id, machineId, path: "" });
  expect(tree.machineName).toBe("Builder");
  expect(tree.rootDirectory).toBe(root);
  expect(
    tree.entries.map((entry) => `${entry.kind}:${entry.name}:${entry.previewKind ?? ""}`),
  ).toEqual(["directory:docs:", "file:big.txt:text", "file:README.md:markdown"]);
});

it("远端字节可以按 Range 取回，未开租约也不影响", async () => {
  const file = await openMachineFile(
    ctx(),
    { projectId: project.id, machineId, path: "docs/data.csv" },
    "bytes=0-3",
  );
  expect(file.status).toBe(206);
  expect(file.length).toBe(4);
  expect(file.contentRange).toBe(`bytes 0-3/${Buffer.byteLength("name,value\na,1\n")}`);
  expect(file.contentType).toBe("text/csv; charset=utf-8");
  expect(await new Response(file.body).text()).toBe("name");
});

it("整份文件跨多个块拼回原字节，越界区间给 416", async () => {
  const file = await openMachineFile(
    ctx(),
    { projectId: project.id, machineId, path: "big.txt" },
    null,
  );
  const text = await new Response(file.body).text();
  expect(text.length).toBe(10_000);
  await expect(
    openMachineFile(ctx(), { projectId: project.id, machineId, path: "big.txt" }, "bytes=99999-"),
  ).rejects.toBeInstanceOf(MachineRangeError);
});

it("围栏在 server 侧先拒一次，越界路径不必占用往返", async () => {
  await expect(
    readMachineTree(ctx(), { projectId: project.id, machineId, path: "../.." }),
  ).rejects.toMatchObject({ code: "validation_failed" });
});

it("未绑定的机器与离线机器给出不同错误，不退化成空树", async () => {
  const otherProject = createProject({ name: "Other" }, owner);
  await expect(
    readMachineTree(ctx(), { projectId: otherProject.id, machineId, path: "" }),
  ).rejects.toBeInstanceOf(MachineBrowseError);
  sqlite
    .prepare("UPDATE machine_connection SET status = 'closed', closed_at = ? WHERE machine_id = ?")
    .run(now, machineId);
  await expect(
    readMachineTree(ctx(), { projectId: project.id, machineId, path: "" }),
  ).rejects.toMatchObject({ code: "conflict", message: "机器不在线" });
  sqlite
    .prepare("UPDATE machine_connection SET status = 'open', closed_at = null WHERE machine_id = ?")
    .run(machineId);
});
