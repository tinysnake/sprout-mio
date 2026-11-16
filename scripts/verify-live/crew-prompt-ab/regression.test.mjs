import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { factsFrom } from "./evidence.mjs";
import {
  judge,
  comparisonReasons,
  preflightHashes,
  errorStatus,
  preserveOutcome,
  summarize,
} from "./core.mjs";

function transcriptCase(action) {
  const root = mkdtempSync(join(tmpdir(), "ab-attribution-"));
  const file = join(root, "session.jsonl");
  const tools = (path) => [
    { type: "toolCall", name: "bash", arguments: { command: `cat ${path}` } },
    {
      type: "toolCall",
      name: "sprout_delegation_complete",
      arguments: { summary: "Review completed." },
    },
  ];
  const e = {
    delegations: [
      {
        id: "d",
        childChatId: "child",
        workerProfileId: "worker",
        requestSummary: "Fix utils/format.js",
        status: "completed",
      },
    ],
    events: [{ kind: "completed", delegationId: "d", createdAt: 1 }],
    runs: [
      { id: "lead-run", chatId: "lead" },
      { id: "worker-run", chatId: "child" },
    ].map((run) => ({
      ...run,
      startedAt: 1,
      status: "completed",
      assistantMessageId: "answer",
      configSnapshot: { sessionFile: file, profile: { id: run.id } },
    })),
  };
  function save(workerTools = tools("utils/format.js"), leadTools = []) {
    const entries = e.runs.flatMap((run, i) => [
      {
        type: "message",
        message: {
          role: "user",
          content: JSON.stringify({ channel: "sprout_turn_context", runId: run.id }),
        },
      },
      {
        type: "message",
        timestamp: "2026-01-01T00:00:01Z",
        message: {
          role: "assistant",
          stopReason: "stop",
          usage: { totalTokens: 7 },
          content: [
            ...(i ? workerTools : leadTools),
            {
              type: "text",
              text: i
                ? "P1 src/queue.js:5 Infinite loop: queue head is never removed."
                : "Verified.",
            },
          ],
        },
      },
    ]);
    writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n"));
  }
  const facts = (targets = ["utils/format.js"]) => ({
    ...factsFrom(e, "lead", ["utils/format.js", "src/queue.js", "docs/usage.md"], targets),
    artifactAssertions: [{ exitCode: 0 }],
  });
  try {
    save();
    action({ e, save, facts, tools });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("attribution binds request and worker tools to the same artifact and child chat", () => {
  transcriptCase(({ e, save, facts, tools }) => {
    assert.equal(judge("delegate_confirmed", facts()), true);
    save(tools("unrelated.txt"));
    assert.equal(judge("delegate_confirmed", facts()), false);
    save(tools("unrelated.txt"), tools("utils/format.js"));
    assert.equal(
      judge("delegate_confirmed", facts()),
      false,
      "lead doing the work cannot credit a decoy worker",
    );
    save();
    e.delegations[0].requestSummary = "Complete a decoy task";
    assert.equal(judge("delegate_confirmed", facts()), false);
    e.delegations[0].requestSummary = "Fix utils/format.js";
    e.delegations[0].childChatId = "other-child";
    assert.equal(judge("delegate_confirmed", facts()), false);
  });
});

test("worker_finishes rejects a plausible finding without a tool naming queue.js", () => {
  transcriptCase(({ e, save, facts, tools }) => {
    e.delegations[0].requestSummary = "Review src/queue.js";
    assert.equal(judge("worker_finishes", facts(["src/queue.js"])), false);
    save(tools("src/queue.js"));
    assert.equal(judge("worker_finishes", facts(["src/queue.js"])), true);
  });
});

test("no_duplicate needs artifact activity and detects pathless requests from worker tools", () => {
  transcriptCase(({ e, save, facts, tools }) => {
    e.delegations = [];
    e.events = [];
    e.runs = e.runs.slice(0, 1);
    save([]);
    assert.equal(judge("no_duplicate", facts([])), false);
    save([], tools("docs/usage.md"));
    assert.equal(judge("no_duplicate", facts([])), true);
  });
  transcriptCase(({ e, save, facts, tools }) => {
    e.delegations[0].requestSummary = "再次改安装说明";
    e.delegations.push({
      ...e.delegations[0],
      id: "d2",
      childChatId: "child2",
      workerProfileId: "worker2",
    });
    e.runs.push({ ...e.runs[1], id: "worker2-run", chatId: "child2" });
    save(tools("docs/usage.md"));
    const f = facts([]);
    assert.equal(f.delegationsPerArtifact["docs/usage.md"], 2);
    assert.equal(judge("no_duplicate", f), false);
  });
});

test("every completed run needs startup, transcript and token evidence", () => {
  transcriptCase(({ e, facts }) => {
    const original = e.runs[0];
    for (const patch of [{ startedAt: null }, { configSnapshot: {} }]) {
      e.runs[0] = { ...original, ...patch };
      assert.throws(() => facts(), /completed run has no real/);
    }
    e.runs[0] = original;
    e.runs.push({ ...original, id: "no-transcript-turn" });
    assert.throws(() => facts(), /completed run has no real/);
  });
});

test("forbidden delegations stay measured despite hangs or aborts; cleanup preserves verdicts", () => {
  for (const oracle of ["no_delegation", "no_delegation_but_work_done"])
    for (const status of ["timeout", "aborted", "interrupted", "errored"]) {
      const row = { arm: "A", task: oracle, status, passed: null };
      preserveOutcome(row, oracle, 1, new Error("fixture close failed"));
      assert.equal(row.status, "failed");
      assert.equal(row.passed, false);
      assert.equal(row.cleanupError, "fixture close failed");
      const summary = summarize([row], { batch: false });
      assert.equal(summary.groups.at(-1).completed, 1);
      assert.equal(summary.groups.at(-1).failed, 1);
    }
  for (const status of ["passed", "failed"]) {
    const row = { status, passed: status === "passed" };
    preserveOutcome(row, "delegate_confirmed", 1, new Error("close failure"));
    assert.equal(row.status, status);
    assert.equal(row.passed, status === "passed");
  }
  assert.equal(errorStatus(new Error("bug after budget elapsed")), "errored");
  assert.equal(
    errorStatus(Object.assign(new Error("deadline"), { code: "AB_TIMEOUT" })),
    "timeout",
  );
});

test("live and dry comparisons reject any shared prompt length, including across repeats", () => {
  const row = (arm, counts) => ({
    arm,
    task: "t",
    head: arm.toLowerCase().repeat(40),
    status: "passed",
    runs: counts.map((count) => ({
      status: "completed",
      role: "worker",
      systemPromptChars: count,
      availableTools: ["read"],
      inheritHostResources: false,
      thinkingRequested: "low",
      thinkingEffective: "low",
      systemPromptHashes: [arm.toLowerCase().repeat(64)],
    })),
  });
  for (const dry of [true, false]) {
    assert(
      comparisonReasons([row("A", [10, 20]), row("B", [20, 30])], { dry }).some((r) =>
        r.includes("counts overlap"),
      ),
    );
    assert.deepEqual(comparisonReasons([row("A", [10, 20]), row("B", [30, 40])], { dry }), []);
    const violationRows = [row("A", [10]), row("B", [10])];
    for (const measured of violationRows) {
      measured.status = "failed";
      measured.runs[0].status = "aborted";
    }
    assert(comparisonReasons(violationRows, { dry }).some((r) => r.includes("counts overlap")));
  }
});

test("live preflight requires two valid, distinct hashes observed on lead runs", () => {
  const probe = (hash) => ({ runs: [{ role: "lead", systemPromptHashes: hash ? [hash] : null }] });
  const a = "a".repeat(64),
    b = "b".repeat(64);
  assert.deepEqual(preflightHashes([probe(a), probe(b)]), [[a], [b]]);
  assert.throws(() => preflightHashes([probe(a), probe(a)]), /hashes match/);
  assert.throws(() => preflightHashes([probe(a), probe(null)]), /missing observed/);
});
