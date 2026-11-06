import { afterAll, expect, it } from "vite-plus/test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
const directory = mkdtempSync(join(tmpdir(), "chat-skills-"));
process.env.DATABASE_URL = join(directory, "test.sqlite");
process.env.SPROUT_PI_DATA_DIR = join(directory, "pi");
process.env.SPROUT_REPO_DIR = join(directory, "repos");
process.env.SPROUT_PI_ENABLED = "false";
const { migrateDatabase } = await import("../src/db/migrate");
migrateDatabase();
const { sqlite } = await import("../src/db");
const { createProject } = await import("../src/domain/project");
const { updateProjectProfile } = await import("../src/domain/project-config");
const { readSkillCatalog, resolveSkillScope, prepareInheritedResources, listChatSkillChoices } =
  await import("../src/server/pi-host/skills");
const ctx = { userId: "skill-human", requestId: "req_skills" };
sqlite
  .prepare(
    "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
  )
  .run(ctx.userId, "skills", "skills@test.example");
afterAll(() => {
  sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});
it("fresh catalogs separate Project scopes before any run; display scans coalesce; disabled never discovers", async () => {
  const a = createProject({ name: "skills A" }, ctx);
  const b = createProject({ name: "skills B" }, ctx);
  for (const [project, name] of [
    [a, "only-a"],
    [b, "only-b"],
  ] as const) {
    updateProjectProfile(project.id, { workDirectory: project.id, defaultBranch: "main" }, ctx);
    const folder = join(directory, "repos", project.id, ".pi/skills", name);
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, "SKILL.md"),
      `---\nname: ${name}\ndescription: isolated fixture\n---\nbody`,
    );
  }
  const { createAgentProfile, addProjectMember } = await import("../src/domain/agent");
  const { createDirectChat } = await import("../src/domain/chat");
  const agent = createAgentProfile({ name: "Skills", persona: "", harness: "pi" }, ctx);
  addProjectMember(a.id, agent.id, ctx);
  const direct = createDirectChat(a.id, agent.id, ctx);
  expect(
    sqlite.prepare("SELECT count(*) AS n FROM agent_run WHERE chat_id=?").get(direct.chat.id),
  ).toEqual({ n: 0 });
  expect(
    (await listChatSkillChoices(direct.chat.id, ctx)).items.some((item) => item.name === "only-a"),
  ).toBe(true);
  console.log("PASS candidate: catalog available before Chat first run");
  const scope = resolveSkillScope(a.id, ctx);
  const [first, second] = await Promise.all([
    readSkillCatalog(scope, "display"),
    readSkillCatalog(scope, "display"),
  ]);
  expect(first).toBe(second);
  expect(first.byName.has("only-a")).toBe(true);
  expect(first.byName.has("only-b")).toBe(false);
  const other = await readSkillCatalog(resolveSkillScope(b.id, ctx), "fresh");
  expect(other.byName.has("only-b")).toBe(true);
  expect(other.byName.has("only-a")).toBe(false);
  process.env.SPROUT_PI_INHERIT_HOST_RESOURCES = "false";
  expect(await prepareInheritedResources(a.id, ctx)).toEqual({ kind: "disabled" });
  delete process.env.SPROUT_PI_INHERIT_HOST_RESOURCES;
  console.log("PASS foundation: zero-run Project isolation, display coalescing, disabled manifest");
});

it("SDK selection includes global/project/enabled package skills, excludes disabled packages, and fresh reads replace display cache", async () => {
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = join(directory, "fixture-agent");
  mkdirSync(agentDir, { recursive: true });
  symlinkSync(
    join(originalAgentDir ?? join(homedir(), ".pi/agent"), "install"),
    join(agentDir, "install"),
    "dir",
  );
  const writeSkill = (base: string, name: string, body: string) => {
    const folder = join(base, "skills", name);
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, "SKILL.md"),
      `---\nname: ${name}\ndescription: selected fixture\n---\n${body}\n`,
    );
  };
  const enabledPackage = join(directory, "enabled-package");
  const disabledPackage = join(directory, "disabled-package");
  for (const [folder, name] of [
    [enabledPackage, "enabled-proof"],
    [disabledPackage, "disabled-proof"],
  ]) {
    writeSkill(folder!, name!, "package body");
    writeFileSync(
      join(folder!, "package.json"),
      JSON.stringify({ name, pi: { skills: ["./skills"] } }),
    );
  }
  writeSkill(agentDir, "global-proof", "global body");
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({
      packages: [{ source: enabledPackage }, { source: disabledPackage, skills: [] }],
    }),
  );
  const project = createProject({ name: "Package selection" }, ctx);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const scope = resolveSkillScope(project.id, ctx);
    mkdirSync(join(scope.resourceCwd, ".git"), { recursive: true });
    writeSkill(join(scope.resourceCwd, ".pi"), "project-proof", "old body");
    const first = await readSkillCatalog(scope, "fresh");
    expect([...first.byName.keys()]).toEqual(
      expect.arrayContaining(["enabled-proof", "global-proof", "project-proof"]),
    );
    expect(first.byName.has("disabled-proof")).toBe(false);
    writeSkill(join(scope.resourceCwd, ".pi"), "project-proof", "new body");
    expect(await readSkillCatalog(scope, "display")).toBe(first);
    const fresh = await readSkillCatalog(scope, "fresh");
    expect(fresh.byName.get("project-proof")?.block).toContain("new body");
    expect(fresh.revision).not.toBe(first.revision);
    expect(await readSkillCatalog(scope, "display")).toBe(fresh);
    expect(fresh.skillPaths).toContain(fresh.byName.get("enabled-proof")?.filePath);
    process.env.SPROUT_PI_INHERIT_HOST_RESOURCES = "0";
    expect(resolveSkillScope(project.id, ctx).sourceKey).not.toBe(scope.sourceKey);
    expect(await prepareInheritedResources(project.id, ctx)).toEqual({ kind: "disabled" });
    console.log(
      "PASS foundation: global/project/enabled-package, disabled-package excluded, display versus fresh, 0 switch invalidation",
    );
  } finally {
    delete process.env.SPROUT_PI_INHERIT_HOST_RESOURCES;
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  }
});
