import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedFixture } from "./fixtures.mjs";
import { artifactAssertions } from "./artifacts.mjs";

const ledgerFindings = JSON.parse(
  readFileSync(new URL("./review-findings.fixture.json", import.meta.url), "utf8"),
);

function withReview(check) {
  const root = mkdtempSync(join(tmpdir(), "ab-review-findings-"));
  try {
    seedFixture("sandbox-review", root);
    check(
      (workerFindings) =>
        artifactAssertions({ fixture: "sandbox-review" }, root, { workerFindings })[0],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const { arm, workerFindings } of ledgerFindings) {
  test(`review accepts exact paired ledger findings from arm ${arm}`, () => {
    withReview((check) => {
      const result = check(workerFindings);
      assert.equal(result.exitCode, 0, result.stderr);
    });
  });
}

test("review accepts detached defect lines while retaining its evidence requirements", () => {
  withReview((check) => {
    const finding = "Reviewed src/queue.js. P1: Infinite loop, head never removed. L4-L5.";
    for (const good of [
      finding,
      finding.replace("L4-L5", "L4–L5"),
      finding.replace("L4-L5", "line 5"),
      finding.replace("L4-L5", "queue.js:5"),
      finding.replace("P1", "blocker"),
    ]) {
      const result = check([good]);
      assert.equal(result.exitCode, 0, result.stderr);
    }
    for (const [reason, bad] of [
      ["no file", finding.replace("src/queue.js", "the module")],
      ["wrong file", finding.replace("src/queue.js", "other/queue.js")],
      ["wrong line", finding.replace("L4-L5", "L1-L2")],
      ["line prefix collision", finding.replace("L4-L5", "L40-L50")],
      ["no line", finding.replace("L4-L5", "the loop")],
      ["no severity", finding.replace("P1", "cosmetic")],
      [
        "no defect description",
        finding.replace("Infinite loop, head never removed", "naming issue"),
      ],
      ["line belongs to another file", finding.replace("L4-L5", "other.js:5")],
      ["file line belongs to another file", finding.replace("L4-L5", "other.js#L5")],
    ]) {
      const result = check([bad]);
      assert.equal(result.exitCode, 1, reason);
      assert.match(result.stderr, /worker findings identify planted non-draining queue defect/);
    }
    assert.equal(
      check(["Reviewed src/queue.js. P1: Infinite loop, head never removed.", "L4-L5"]).exitCode,
      1,
      "file, line, severity and defect must be in the same finding",
    );
  });
});
