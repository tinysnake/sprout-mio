import { afterAll, describe, expect, it, vi } from "vite-plus/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MachineContext } from "../src/domain/machine";
import type { ProjectContext } from "../src/domain/access";

const directory = mkdtempSync(join(tmpdir(), "p5b-info-hub-revision-"));
process.env.DATABASE_URL = join(directory, "info.sqlite");
const { migrateDatabase } = await import("../src/db/migrate");
migrateDatabase();
const { sqlite } = await import("../src/db");
const { newId, ID_PREFIXES } = await import("../src/contracts/ids");
const { createProject } = await import("../src/domain/project");
const { createAgentProfile, addProjectMember } = await import("../src/domain/agent");
const { createDirectChat, ensureInstance, updateChatTitle } = await import("../src/domain/chat");
const { getInfoHub, refreshInfoHub } = await import("../src/domain/info-hub");
const { WORKER_STALE_AFTER_MS } = await import("../src/contracts/worker");

sqlite
  .prepare(
    "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES ('usr_rev','Rev','rev@revision.test',0,1,1)",
  )
  .run();
const seen = new Date("2026-01-01T00:00:00.000Z");
const bootId = newId(ID_PREFIXES.boot);
sqlite
  .prepare(
    "INSERT INTO runtime_boot(id,started_at,phase,pid,app_version) VALUES (?,?,'ready',1,'revision-test')",
  )
  .run(bootId, Math.floor(seen.getTime() / 1000) - 60);
const base: ProjectContext & MachineContext = {
  userId: "usr_rev",
  requestId: newId(ID_PREFIXES.request),
  bootId,
  now: seen,
};
const sections = ["agents", "chats", "tasks", "machines"] as const;
type Section = (typeof sections)[number];

function connect(machineId: string, lastSeenAt: Date) {
  sqlite
    .prepare(
      "INSERT INTO machine_connection(machine_id,generation,attempt_id,boot_id,status,opened_at,last_seen_at,seq,capability,last_payload_hash) VALUES (?,1,?,?,'open',?,?,1,'{}',?)",
    )
    .run(
      machineId,
      `attempt-${machineId}`,
      bootId,
      lastSeenAt.getTime(),
      lastSeenAt.getTime(),
      "a".repeat(64),
    );
}
function machine(projectId: string, name: string, holderInstanceId?: string) {
  const id = newId(ID_PREFIXES.machine);
  sqlite
    .prepare("INSERT INTO machine(id,name,created_by,created_at,updated_at) VALUES (?,?,?,1,1)")
    .run(id, name, base.userId);
  sqlite
    .prepare(
      "INSERT INTO project_machine(project_id,machine_id,created_by,revision,created_at,updated_at) VALUES (?,?,?,1,1,1)",
    )
    .run(projectId, id, base.userId);
  if (holderInstanceId)
    sqlite
      .prepare(
        "INSERT INTO machine_lease(project_id,machine_id,generation,state,holder_instance_id,changed_at) VALUES (?,?,1,'held',?,1)",
      )
      .run(projectId, id, holderInstanceId);
  return id;
}
function profile(projectId: string, name: string) {
  const created = createAgentProfile({ name, persona: "", harness: "pi" }, base);
  addProjectMember(projectId, created.id, base);
  return created;
}
/** 两个 Chat、两台 Machine：Chat 分页与「改这一台不影响那一台」都要有第二个对象才测得出来。 */
function fixture() {
  const project = createProject({ name: "Revision" }, base);
  const alpha = profile(project.id, "Alpha");
  const beta = profile(project.id, "Beta");
  const alphaChat = createDirectChat(project.id, alpha.id, base).chat;
  const betaChat = createDirectChat(project.id, beta.id, base).chat;
  const alphaInstance = ensureInstance(alphaChat.id, alpha.id, base);
  const betaInstance = ensureInstance(betaChat.id, beta.id, base);
  const first = machine(project.id, "First", alphaInstance.id);
  const second = machine(project.id, "Second", betaInstance.id);
  connect(first, seen);
  connect(second, seen);
  return { project, alphaChat, betaChat, alphaInstance, betaInstance, first, second };
}
const query = (name: Section) => ({ view: "project" as const, section: name, limit: 50 });
function view(f: ReturnType<typeof fixture>, name: Section, ctx = base) {
  return getInfoHub(f.project.id, query(name), ctx);
}
/** 分节视图才带 data/page：契约的联合里只有分节 member 有这两项。 */
function chatsOf(f: ReturnType<typeof fixture>, ctx = base) {
  const current = view(f, "chats", ctx);
  if (current.view !== "project" || current.section !== "chats")
    throw new Error("project/chats expected");
  return current;
}
function machinesOf(f: ReturnType<typeof fixture>, ctx = base) {
  const current = view(f, "machines", ctx);
  if (current.view !== "project" || current.section !== "machines")
    throw new Error("project/machines expected");
  return current;
}
function machineViewOf(f: ReturnType<typeof fixture>, machineId: string) {
  const current = getInfoHub(f.project.id, { view: "machine", machineId }, base);
  if (current.view !== "machine") throw new Error("machine view expected");
  return current;
}
const machineOf = <T extends { machineId: string }>(data: T[], machineId: string) =>
  data.find((item) => item.machineId === machineId)!;
function cursorStale(run: () => unknown) {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return "no error";
}
afterAll(() => {
  sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("Info Hub revision is the identity of one section payload", () => {
  it("keeps every Project section unchanged when only the connection heartbeat moves", () => {
    const f = fixture();
    const before = new Map(sections.map((name) => [name, view(f, name)]));
    const heartbeatPayload = machinesOf(f).data;
    const beat = new Date(seen.getTime() + WORKER_STALE_AFTER_MS / 2);
    sqlite
      .prepare(
        "UPDATE machine_connection SET last_seen_at = ? WHERE machine_id IN (SELECT machine_id FROM project_machine WHERE project_id = ?)",
      )
      .run(beat.getTime(), f.project.id);
    const after = machinesOf(f, { ...base, now: beat });
    // 心跳确实改了载荷：lastSeenAt 值与 asOf 都动了，否则下面「unchanged」不证明任何事。
    expect(after.data).not.toEqual(heartbeatPayload);
    expect(after.data.map((item) => item.connection.kind)).toEqual(["online", "online"]);
    for (const name of sections) {
      const now = view(f, name, { ...base, now: beat });
      expect(now.revision).toBe(before.get(name)!.revision);
      expect(
        refreshInfoHub(f.project.id, query(name), before.get(name)!.revision, base),
      ).toMatchObject({ kind: "unchanged" });
    }
  });

  it("changes project/machines when the connection goes stale and reads offline", () => {
    const f = fixture();
    const online = machinesOf(f);
    expect(online.data.map((item) => item.connection.kind)).toEqual(["online", "online"]);
    const stale = machinesOf(f, { ...base, now: new Date(seen.getTime() + WORKER_STALE_AFTER_MS) });
    // 同一份连接数据，只有 kind 从 online 掉到 offline：可见状态变了，revision 必须跟着变。
    expect(stale.data.map((item) => item.connection.kind)).toEqual(["offline", "offline"]);
    expect(stale.revision).not.toBe(online.revision);
  });

  it("scopes revision to the section payload: an unrelated Chat rename leaves project/machines alone", () => {
    const f = fixture();
    const unrelated = createDirectChat(f.project.id, profile(f.project.id, "Gamma").id, base).chat;
    const chats = chatsOf(f);
    const machines = machinesOf(f);
    updateChatTitle(unrelated.id, "改过的标题", { kind: "human", userId: base.userId, ctx: base });
    const renamed = chatsOf(f);
    expect(renamed.data.map((item) => item.displayTitle)).toContain("改过的标题");
    expect(renamed.revision).not.toBe(chats.revision);
    expect(machinesOf(f).revision).toBe(machines.revision);
    expect(refreshInfoHub(f.project.id, query("chats"), chats.revision, base).kind).toBe("changed");
    expect(refreshInfoHub(f.project.id, query("machines"), machines.revision, base).kind).toBe(
      "unchanged",
    );
    // 机器摘要里带持有者 Chat 的展示标题：改那个 Chat 的名字确实改了 machine 载荷。
    updateChatTitle(f.alphaChat.id, "Alpha 的 Chat", {
      kind: "human",
      userId: base.userId,
      ctx: base,
    });
    expect(machinesOf(f).revision).not.toBe(machines.revision);
  });

  it("changes project/machines when a lease generation or holder moves", () => {
    const f = fixture();
    const initial = machinesOf(f);
    sqlite
      .prepare("UPDATE machine_lease SET generation = generation + 1 WHERE machine_id = ?")
      .run(f.first);
    const fenced = machinesOf(f);
    expect(machineOf(fenced.data, f.first).lease).toMatchObject({
      generation: 2,
      holderInstanceId: f.alphaInstance.id,
    });
    expect(fenced.revision).not.toBe(initial.revision);
    sqlite
      .prepare("UPDATE machine_lease SET holder_instance_id = ? WHERE machine_id = ?")
      .run(f.betaInstance.id, f.first);
    const handed = machinesOf(f);
    expect(machineOf(handed.data, f.first).lease).toMatchObject({
      holderInstanceId: f.betaInstance.id,
    });
    expect(handed.revision).not.toBe(fenced.revision);
  });

  it("keeps revision when the clock only moves asOf", () => {
    const f = fixture();
    vi.useFakeTimers({ now: seen, toFake: ["Date"] });
    try {
      const first = chatsOf(f);
      vi.setSystemTime(new Date(seen.getTime() + 3_600_000));
      const later = chatsOf(f);
      // asOf 只描述「这次读发生在什么时候」，不进 revision。
      expect(later.asOf).not.toBe(first.asOf);
      expect(later.revision).toBe(first.revision);
      expect(refreshInfoHub(f.project.id, query("chats"), first.revision, base).kind).toBe(
        "unchanged",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("binds a cursor to the same revision across pages and drops it when the section changes", () => {
    const f = fixture();
    const page = (cursor?: string) => {
      const current = getInfoHub(
        f.project.id,
        { view: "project", section: "chats", limit: 1, cursor },
        base,
      );
      if (current.view !== "project" || current.section !== "chats")
        throw new Error("project/chats expected");
      return current;
    };
    const first = page();
    expect(first.page.total).toBeGreaterThan(1);
    const pageCursor = first.page.nextCursor!;
    const walked = [first.data[0]!.chatId];
    let cursor: string | null = pageCursor;
    while (cursor) {
      const next = page(cursor);
      // 翻页只换窗口，不换载荷身份：每一页拿到同一个 revision。
      expect(next.revision).toBe(first.revision);
      walked.push(next.data[0]!.chatId);
      cursor = next.page.nextCursor;
    }
    expect(walked).toHaveLength(first.page.total);
    expect(new Set(walked).size).toBe(first.page.total);
    updateChatTitle(f.betaChat.id, "翻页后改名", { kind: "human", userId: base.userId, ctx: base });
    expect(cursorStale(() => page(pageCursor))).toBe("info_hub_cursor_stale");
  });

  it("gives view: machine a revision that tracks only that machine's own payload", () => {
    const f = fixture();
    const single = () => machineViewOf(f, f.first);
    const initial = single();
    const machines = machinesOf(f);
    sqlite
      .prepare("UPDATE project_machine SET description = '另一台改名' WHERE machine_id = ?")
      .run(f.second);
    expect(machinesOf(f).revision).not.toBe(machines.revision);
    expect(single().revision).toBe(initial.revision);
    sqlite
      .prepare("UPDATE project_machine SET description = '这一台改名' WHERE machine_id = ?")
      .run(f.first);
    expect(single().revision).not.toBe(initial.revision);
  });
});
