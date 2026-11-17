import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { summarize } from "./core.mjs";
import { inventory, defaultFacts, sectionInventory, toolInventory, compareInventories, renderComparison } from "./prompt-inventory.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const oldRef = "277f506c15fe771bbd337efa259dc517c3ffc1cd";
const newRef = "0130cbece1fde9d5e34e328f05c00475d534b615";

test("sections retain separators and reconcile exactly, with absent crew sections at zero", () => {
  const text = "## 情境\n甲\n\n## 职责\n乙\n\n## HTML 交付\n丙";
  const result = sectionInventory(text);
  assert.equal(result.totalChars, text.length);
  assert.equal(result.sections.reduce((n, s) => n + s.chars, 0), text.length);
  assert.equal(result.sections.find(s => s.name === "成员选择").chars, 0);
  assert.equal(sectionInventory("legacy").crewChars, 0);
  assert.equal(sectionInventory("legacy").sections.find(s => s.name === "legacy").chars, 6);
  const legacy = sectionInventory("persona\n\nhtml", { htmlGuide: "\n\nhtml" });
  assert.equal(legacy.sections.find(s => s.name === "HTML 交付").chars, 6);
  assert.equal(legacy.crewChars, 0);
});

test("tool sizes include nested parameter descriptions, but exclude schema syntax and examples", () => {
  const result = toolInventory([
    { name: "small", description: "a", parameters: {} },
    { name: "large", description: "abc", parameters: { description: "xy", properties: { nested: { items: { description: "中文" } } }, examples: [{ description: "not schema" }] } },
  ]);
  assert.deepEqual(result.tools.map(t => [t.name, t.descriptionChars, t.parameterDescriptionChars, t.totalChars]), [["large", 3, 4, 7], ["small", 1, 0, 1]]);
  assert.equal(result.totalChars, 8);
});

test("comparison computes compression against A for each role and handles a zero baseline", () => {
  const role = (s, t) => ({ systemPrompt: { totalChars: s }, tools: { totalChars: t } });
  const result = compareInventories([{ arm: "A", roles: { lead: role(100, 0), worker: role(200, 40) } }, { arm: "B", roles: { lead: role(80, 10), worker: role(220, 20) } }]);
  assert.equal(result.rows[1].systemPromptCompressionPercent, 20);
  assert.equal(result.rows[1].toolDescriptionCompressionPercent, null);
  assert.equal(result.rows[3].systemPromptCompressionPercent, -10);
  assert.equal(result.rows[3].toolDescriptionCompressionPercent, 50);
  assert.match(renderComparison(result), /体量对比/);
  assert.match(renderComparison(result), /20\.00%/);
});

test("A/B summary includes the prompt-size comparison when both inventories are present", () => {
  const role = { systemPrompt: { totalChars: 100 }, tools: { totalChars: 300 } };
  const inventories = ["A", "B"].map(arm => ({ arm, roles: { lead: role, worker: role } }));
  const summary = summarize([], { promptInventories: inventories });
  assert.equal(summary.promptSizeComparison.rows.length, 4);
  assert.equal(summary.promptSizeComparison.rows[1].toolDescriptionCompressionPercent, 0);
  assert.equal(summarize([]).promptSizeComparison, undefined);
});

test("both real refs use their runner and role allowlist, with clean detached-worktree lifecycle", { timeout: 120000 }, async () => {
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  const before = git("worktree", "list", "--porcelain");
  const branch = git("branch", "--show-current");
  const a = await inventory(oldRef, { root });
  const b = await inventory(newRef, { root });
  const repeated = await inventory(newRef, { root });
  assert.deepEqual(repeated.roles, b.roles, "random checkout paths must not affect counts");
  await assert.rejects(inventory("refs/heads/prompt-inventory-missing-ref", { root }));
  await assert.rejects(inventory(newRef, {
    root,
    facts: { ...defaultFacts, profile: undefined },
  }), /persona/);
  const existing = await inventory(root, { root });
  assert.equal(existing.target, root.replace(/\/$/, ""));
  assert.equal(existing.head, git("rev-parse", "HEAD").trim());
  for (const role of ["lead", "worker"]) {
    assert.equal(a.roles[role].systemPrompt.crewChars, 0);
    assert.ok(b.roles[role].systemPrompt.crewChars > 0);
    assert.equal(b.roles[role].systemPrompt.sections.reduce((n, s) => n + s.chars, 0), b.roles[role].systemPrompt.totalChars);
    assert.ok(b.roles[role].systemPrompt.hostChars > 0);
    assert.ok(a.roles[role].systemPrompt.sections.find(s => s.name === "HTML 交付").chars > 0);
    assert.ok(b.roles[role].tools.totalChars > 1000);
    assert.equal(b.roles[role].tools.tools.reduce((n, t) => n + t.totalChars, 0), b.roles[role].tools.totalChars);
    assert.ok(b.roles[role].tools.tools.some(t => t.name === "read"));
  }
  const names = role => b.roles[role].tools.tools.map(t => t.name);
  assert.ok(names("lead").includes("sprout_delegation_start"));
  assert.ok(!names("lead").includes("sprout_delegation_complete"));
  assert.ok(names("worker").includes("sprout_delegation_complete"));
  assert.ok(!names("worker").includes("sprout_delegation_start"));
  assert.equal(git("worktree", "list", "--porcelain"), before);
  assert.equal(git("branch", "--show-current"), branch);
});
