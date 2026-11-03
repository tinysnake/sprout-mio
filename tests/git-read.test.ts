import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { createGitReadTool } from "../src/extension/git-read";

const repo = mkdtempSync(join(tmpdir(), "sprout-git-read-"));
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

git("init", "-q");
git("config", "user.name", "Alice");
git("config", "user.email", "alice@example.com");
writeFileSync(join(repo, "a.txt"), "hello\n");
writeFileSync(join(repo, "b.txt"), "other\n");
git("add", ".");
git("commit", "-q", "-m", "initial commit");
git("branch", "feature");
git("tag", "v1");
writeFileSync(join(repo, "a.txt"), "hello changed\n");

const tool = createGitReadTool({ cwd: repo, timeoutMs: 5_000 });

async function run(input: Record<string, unknown>) {
  return tool.execute("probe", input);
}

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("git_read", () => {
  it("reads status and log without writing", async () => {
    const status = await run({ operation: "status" });
    expect(status.isError).toBeUndefined();
    expect(status.content[0]).toMatchObject({ type: "text" });
    expect((status.content[0] as { text: string }).text).toContain("a.txt");

    const log = await run({ operation: "log", maxCount: 5 });
    expect(log.isError).toBeUndefined();
    expect((log.content[0] as { text: string }).text).toContain("initial commit");
  });

  it("reads show, diff, blame, branches, tags, files, grep, and rev-parse", async () => {
    const show = await run({ operation: "show", ref: "HEAD" });
    expect((show.content[0] as { text: string }).text).toContain("a.txt");

    const diff = await run({ operation: "diff", path: "a.txt" });
    expect((diff.content[0] as { text: string }).text).toContain("hello changed");

    const blame = await run({ operation: "blame", path: "a.txt" });
    expect((blame.content[0] as { text: string }).text).toContain("Alice");

    const branches = await run({ operation: "branches", all: true });
    expect((branches.content[0] as { text: string }).text).toContain("feature");

    const tags = await run({ operation: "tags" });
    expect((tags.content[0] as { text: string }).text).toContain("v1");

    const files = await run({ operation: "ls_files" });
    expect((files.content[0] as { text: string }).text).toContain("a.txt");

    const grep = await run({ operation: "grep", pattern: "hello" });
    expect((grep.content[0] as { text: string }).text).toContain("a.txt");

    const rev = await run({ operation: "rev_parse", ref: "HEAD" });
    expect((rev.content[0] as { text: string }).text.trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  it("supports pickaxe history search", async () => {
    writeFileSync(join(repo, "a.txt"), "hello changed\n");
    git("add", "a.txt");
    git("commit", "-q", "-m", "change hello");
    writeFileSync(join(repo, "a.txt"), "hello\n");
    git("add", "a.txt");
    git("commit", "-q", "-m", "restore hello");
    const pickaxe = await run({
      operation: "log",
      pickaxe: { mode: "string", value: "hello changed" },
    });
    expect(pickaxe.isError).toBeUndefined();
    expect((pickaxe.content[0] as { text: string }).text).toContain("restore hello");
  });

  it("rejects paths outside the repository and option-like refs", async () => {
    const escape = await run({ operation: "blame", path: "../outside.txt" });
    expect(escape.isError).toBe(true);
    const injection = await run({ operation: "show", ref: "--help" });
    expect(injection.isError).toBe(true);
    const unknown = await run({ operation: "push" });
    expect(unknown.isError).toBe(true);
  });
});
