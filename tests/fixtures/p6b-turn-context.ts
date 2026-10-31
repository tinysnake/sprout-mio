import { execFileSync } from "node:child_process";
import { p6bFixture } from "./p6b-support";
import { turnContextPromptInputSchema } from "../../src/contracts/turn-context";
import type { InfoHubHint } from "../../src/contracts/info-hub-hint";
const { promptWithTurnContext } = await import(
  new URL("../../scripts/pi-host-turn-context.mjs", import.meta.url).href
);
const f = await p6bFixture("turn-context");
const { InfoHubHintChannel } = await import("../../src/domain/info-hub-hint");
try {
  const inputB = { projectId: f.p.id, runId: f.runB };
  const b = f.turns.captureTurnContext(inputB, f.ctx);
  f.equal(b.instanceId, f.instanceB.id);
  f.equal(b.agentProfileId, f.b.id);
  f.equal(
    b.heldMachines.map((machine) => machine.machineId),
    [f.machineB],
  );
  f.check(
    b.chatRuns.some(
      (run) => run.isSelf && run.runId === f.runB && run.instanceId === f.instanceB.id,
    ),
    "snapshot self is its run, never the Chat's first instance",
  );
  f.equal(b.deliveryState, "prepared");
  f.equal(b.injectedIntoPrompt, false);
  f.equal(
    f.turns.readTurnContext({ projectId: f.p.id, runId: f.runNeighbor }, f.ctx).kind,
    "not_captured",
  );
  f.throws(
    () => f.turns.prepareTurnContext({ projectId: f.p.id, runId: f.runNeighbor }, f.ctx),
    "turn_context_unavailable",
  );
  f.throws(() => f.turns.captureTurnContext(inputB, f.agentCtx), "forbidden");
  f.sqlite
    .prepare("UPDATE task SET title='Changed title',revision=revision+1 WHERE project_id=?")
    .run(f.p.id);
  f.equal(
    f.turns.captureTurnContext(inputB, f.ctx),
    b,
    "recapture preserves exact original body and basis",
  );
  f.throws(() =>
    f.sqlite
      .prepare("UPDATE turn_context SET serialized_text='changed' WHERE run_id=?")
      .run(f.runB),
  );
  f.throws(() => f.sqlite.prepare("DELETE FROM turn_context WHERE run_id=?").run(f.runB));
  const prepared = f.turns.prepareTurnContext(inputB, f.ctx);
  f.equal(prepared.serializedText, b.serializedText);
  f.throws(
    () =>
      f.turns.confirmTurnContext(
        { runId: f.runB, contentHash: "0".repeat(64), submittedAt: new Date().toISOString() },
        f.ctx,
      ),
    "turn_context_unavailable",
  );
  f.throws(
    () =>
      f.turns.confirmTurnContext(
        { runId: f.runB, contentHash: b.contentHash, submittedAt: "2000-01-01T00:00:00.000Z" },
        f.ctx,
      ),
    "turn_context_unavailable",
  );
  const receipts: { runId: string; contentHash: string; submittedAt: string }[] = [];
  let listener: ((event: { type: string }) => void) | undefined;
  let sentText = "";
  let unsubscribeCount = 0;
  const session = {
    subscribe(fn: typeof listener) {
      listener = fn;
      return () => {
        listener = undefined;
        unsubscribeCount++;
      };
    },
    async prompt(text: string) {
      sentText = text;
      listener?.({ type: "agent_start" });
      listener?.({ type: "agent_start" });
    },
  };
  await promptWithTurnContext(
    session,
    { id: f.runB, text: "ADMITTED_INPUT", turnContext: prepared },
    turnContextPromptInputSchema,
    new Set(),
    (receipt: { runId: string; contentHash: string; submittedAt: string }) =>
      receipts.push(receipt),
  );
  f.equal(sentText, `${b.serializedText}\n\nADMITTED_INPUT`);
  f.equal(receipts.length, 1, "one SDK event yields one receipt");
  f.equal(unsubscribeCount, 1);
  f.equal(f.turns.readTurnContext(inputB, f.ctx).kind, "captured");
  f.equal(
    f.sqlite.prepare("SELECT delivery_state FROM turn_context WHERE run_id=?").get(f.runB),
    { delivery_state: "prepared" },
    "receipt generation alone does not persist submitted",
  );
  const { runId, contentHash, submittedAt } = receipts[0]!;
  const submitted = f.turns.confirmTurnContext({ runId, contentHash, submittedAt }, f.ctx);
  f.equal(submitted.deliveryState, "submitted");
  f.equal(submitted.injectedIntoPrompt, true);
  f.equal(submitted.serializedText, b.serializedText);
  f.equal(f.turns.confirmTurnContext({ runId, contentHash, submittedAt }, f.ctx), submitted);
  f.throws(() =>
    f.sqlite
      .prepare("UPDATE turn_context SET delivery_state='prepared',submitted_at=NULL WHERE run_id=?")
      .run(f.runB),
  );
  let rejectedReceipts = 0;
  try {
    await promptWithTurnContext(
      {
        ...session,
        async prompt() {
          throw new Error("SDK rejected");
        },
      },
      { id: f.runA, text: "input", turnContext: { ...prepared, runId: f.runA } },
      turnContextPromptInputSchema,
      new Set(),
      () => rejectedReceipts++,
    );
  } catch {
    /* expected */
  }
  f.equal(rejectedReceipts, 0, "rejected SDK prompt never acknowledges submission");
  for (let i = 0; i < 80; i++) {
    const task = f.tasks.createTask(
      {
        projectId: f.p.id,
        title: `任务${i}${"多字节".repeat(30)}`,
        description: "SECRET_BODY",
        constraints: "",
        completionRequirements: "",
        checklist: [],
      },
      f.ctx,
    ).detail;
    f.tasks.assignTask(
      { taskId: task.task.id, expectedRevision: task.task.revision, targetChatId: f.chat.id },
      f.ctx,
    );
  }
  const a = f.turns.captureTurnContext({ projectId: f.p.id, runId: f.runA }, f.ctx);
  f.check(
    a.truncated && a.omittedCounts.tasks > 0,
    "oversized snapshot records structural omissions",
  );
  f.check(Buffer.byteLength(a.serializedText) <= 8192, "UTF-8 bytes are bounded");
  const text = JSON.parse(a.serializedText);
  f.equal(text.sections.tasks.total, text.sections.tasks.returned + text.sections.tasks.omitted);
  f.equal(text.sections.tasks.nextQuery.section, "tasks");
  f.check(
    a.chatRuns.some((run) => run.isSelf && run.runId === f.runA),
    "trimming retains this run's identity",
  );
  f.check(!a.serializedText.includes("SECRET"), "snapshot contains no task/message body");
  const restored = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `const {readTurnContext}=await import('./src/domain/turn-context.ts'); const r=readTurnContext(${JSON.stringify(inputB)},${JSON.stringify(f.ctx)}); console.log(JSON.stringify(r));`,
      ],
      {
        env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
        encoding: "utf8",
        timeout: 60000,
      },
    ).trim(),
  );
  f.equal(
    restored.record.serializedText,
    b.serializedText,
    "fresh process reads persisted immutable text",
  );
  f.equal(restored.record.deliveryState, "submitted");
  const hints: InfoHubHint[] = [];
  const channel = new InfoHubHintChannel(f.runA, f.ctx, (hint) => {
    hints.push(hint);
  });
  const before = {
    messages: f.sqlite.prepare("SELECT count(*) n FROM message").get(),
    runs: f.sqlite.prepare("SELECT count(*) n FROM agent_run").get(),
    notices: f.sqlite.prepare("SELECT count(*) n FROM run_resource_notice").get(),
  };
  const clock = Date.now();
  f.sqlite.prepare("UPDATE task SET revision=revision+1 WHERE project_id=?").run(f.p.id);
  await channel.tick(clock);
  await channel.tick(clock + 1999);
  f.equal(hints.length, 0);
  await channel.tick(clock + 2000);
  f.equal(hints.length, 1);
  await channel.tick(clock + 3000);
  f.equal(hints.length, 1, "unchanged facts dedupe");
  f.sqlite.prepare("UPDATE task SET revision=revision+1 WHERE project_id=?").run(f.p.id);
  await channel.tick(clock + 3001);
  await channel.tick(clock + 6000);
  f.equal(hints.length, 1, "minimum interval prevents a second early hint");
  await channel.tick(clock + 7000);
  f.equal(hints.length, 2);
  // A → B → A on a fresh channel: adding a member delivers once, removing it delivers the reverse
  // once, and adding again returns to the revision already reported. The `seen` layer must suppress
  // that repeat — otherwise the basis (now B) sees a real diff and a third hint goes out at the same
  // revision. A later, genuinely new revision proves the channel was still able to deliver.
  const third = f.agents.createAgentProfile({ name: "Gamma", persona: "", harness: "pi" }, f.ctx);
  f.agents.addProjectMember(f.p.id, third.id, f.ctx);
  const actor = { kind: "human" as const, userId: f.ctx.userId, ctx: f.ctx };
  const repeated: InfoHubHint[] = [];
  const repeatChannel = new InfoHubHintChannel(f.runA, f.ctx, (hint) => {
    repeated.push(hint);
  });
  const governance = () => f.chats.getChat(f.chat.id, f.ctx).governanceRevision;
  const addThird = () =>
    f.chats.addGroupMember(f.chat.id, { kind: "agent", id: third.id }, governance(), actor);
  const removeThird = () =>
    f.chats.removeGroupMember(f.chat.id, { kind: "agent", id: third.id }, governance(), actor);
  addThird();
  await repeatChannel.tick(clock + 30_000);
  await repeatChannel.tick(clock + 32_000);
  f.equal(repeated.length, 1, "a member change is delivered after the merge window");
  const firstRevision = repeated[0]!.revision;
  removeThird();
  await repeatChannel.tick(clock + 33_000);
  await repeatChannel.tick(clock + 40_000);
  f.equal(repeated.length, 2, "the reverse change is delivered after the minimum interval");
  f.check(
    repeated[1]!.revision !== firstRevision,
    "the reverse change carries a different revision",
  );
  addThird();
  await repeatChannel.tick(clock + 41_000);
  await repeatChannel.tick(clock + 50_000);
  f.equal(
    repeated.length,
    2,
    "returning to an already-reported revision delivers no second hint for it",
  );
  f.sqlite.prepare("UPDATE task SET revision=revision+1 WHERE project_id=?").run(f.p.id);
  await repeatChannel.tick(clock + 51_000);
  await repeatChannel.tick(clock + 56_000);
  f.equal(repeated.length, 3, "the channel still delivers a revision it has never reported");
  repeatChannel.dispose();
  f.check(
    hints.every(
      (hint) =>
        hint.runId === f.runA &&
        hint.changes.some((change) => change.kind === "task_summary") &&
        Buffer.byteLength(JSON.stringify(hint)) <= 1024,
    ),
    "hint has bounded current-run facts",
  );
  f.equal(
    {
      messages: f.sqlite.prepare("SELECT count(*) n FROM message").get(),
      runs: f.sqlite.prepare("SELECT count(*) n FROM agent_run").get(),
      notices: f.sqlite.prepare("SELECT count(*) n FROM run_resource_notice").get(),
    },
    before,
    "hints do not write messages, admit runs, or enqueue notices",
  );
  const deliveredBeforeSettle = hints.length;
  f.sqlite
    .prepare(
      "UPDATE agent_run SET status='failed',settled_at=?,error_code='fixture',error_message='done' WHERE id=?",
    )
    .run(Date.now(), f.runA);
  f.sqlite.prepare("UPDATE task SET revision=revision+1 WHERE project_id=?").run(f.p.id);
  await channel.tick(clock + 20_000);
  f.equal(hints.length, deliveredBeforeSettle, "settled runs receive no hints");
  channel.dispose();
  f.finish();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
