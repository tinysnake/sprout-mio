import { expect, it } from "vite-plus/test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectInput, updateProjectInput } from "../src/contracts/project";
import { createAgentProfileInput, updateAgentProfileInput } from "../src/contracts/agent";
import { migrateDatabase } from "../src/db/migrate";
import { openDatabase } from "../src/db/connection";

it("project kind and prompt and independent agent description validate partial updates", () => {
  expect(createProjectInput.parse({ name: "New" }).kind).toBe("coding");
  expect(updateProjectInput.parse({ kind: "work" })).toEqual({ kind: "work" });
  expect(updateProjectInput.parse({ agentPrompt: null })).toEqual({ agentPrompt: null });
  expect(createProjectInput.safeParse({ name: "New", kind: "other" }).success).toBe(false);
  expect(createProjectInput.safeParse({ name: "New", agentPrompt: "x".repeat(2001) }).success).toBe(
    false,
  );
  expect(updateProjectInput.safeParse({}).success).toBe(false);
  expect(
    createAgentProfileInput.parse({ name: "Reviewer", description: "Review code" }).description,
  ).toBe("Review code");
  expect(updateAgentProfileInput.parse({ description: null })).toEqual({ description: null });
  expect(updateAgentProfileInput.safeParse({ description: "x".repeat(501) }).success).toBe(false);
});

it("upgrades existing projects conservatively and enforces new fields directly in SQL", () => {
  const directory = mkdtempSync(join(tmpdir(), "project-context-upgrade-"));
  const file = join(directory, "upgrade.sqlite");
  const folder = join(directory, "old");
  mkdirSync(join(folder, "meta"), { recursive: true });
  const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
  journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 67);
  for (const entry of journal.entries)
    copyFileSync(join("drizzle", `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  writeFileSync(join(folder, "meta", "_journal.json"), JSON.stringify(journal));
  let sqlite: ReturnType<typeof openDatabase>["sqlite"] | undefined;
  try {
    migrateDatabase(file, folder);
    sqlite = openDatabase(file).sqlite;
    sqlite.exec(`INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES ('human','Human','upgrade@test.example',0,1,1);
      INSERT INTO project(id,name,description,created_by) VALUES ('old','Old','Preserve me','human');
      INSERT INTO agent_profile(id,name,persona,created_by) VALUES ('worker','Worker','Old persona','human');`);
    sqlite.close();
    migrateDatabase(file);
    migrateDatabase(file);
    sqlite = openDatabase(file).sqlite;
    expect(
      sqlite.prepare("SELECT kind,agent_prompt,description FROM project WHERE id='old'").get(),
    ).toEqual({ kind: "custom", agent_prompt: null, description: "Preserve me" });
    expect(
      sqlite.prepare("SELECT description,persona FROM agent_profile WHERE id='worker'").get(),
    ).toEqual({ description: null, persona: "Old persona" });
    for (const kind of ["coding", "work", "custom"])
      sqlite
        .prepare("UPDATE project SET kind=?,agent_prompt=? WHERE id='old'")
        .run(kind, "x".repeat(2000));
    expect(() => sqlite!.exec("UPDATE project SET kind='unknown' WHERE id='old'")).toThrow(
      /CHECK constraint/,
    );
    expect(() => sqlite!.exec("UPDATE project SET kind=NULL WHERE id='old'")).toThrow(/NOT NULL/);
    expect(() =>
      sqlite!.prepare("UPDATE project SET agent_prompt=? WHERE id='old'").run("x".repeat(2001)),
    ).toThrow(/CHECK constraint/);
    sqlite.prepare("UPDATE agent_profile SET description=? WHERE id='worker'").run("x".repeat(500));
    expect(() =>
      sqlite!
        .prepare("UPDATE agent_profile SET description=? WHERE id='worker'")
        .run("x".repeat(501)),
    ).toThrow(/CHECK constraint/);
    sqlite.exec("UPDATE project SET agent_prompt=NULL; UPDATE agent_profile SET description=NULL;");
    expect(() =>
      sqlite!.exec("UPDATE agent_profile SET purpose='assistant' WHERE id='worker'"),
    ).toThrow("agent purpose is immutable");
    expect(sqlite.pragma("foreign_key_check")).toEqual([]);
    expect(sqlite.pragma("integrity_check", { simple: true })).toBe("ok");
  } finally {
    if (sqlite?.open) sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
