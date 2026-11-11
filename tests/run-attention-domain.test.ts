import { describe, expect, it, vi } from "vite-plus/test";
vi.mock("../src/db", () => ({ db: {}, sqlite: {} }));
import {
  DEFAULT_RUN_ATTENTION_POLICY,
  resolveRunAttentionPolicy,
} from "../src/contracts/run-attention";
import { projectWakePolicySchema } from "../src/contracts/project-wake-policy";
import {
  runAttentionFacts,
  runAttentionStep,
  type RunAttentionStepInput,
} from "../src/domain/run-attention";
import { agentRun } from "../src/db/schema";

const start = new Date("2026-11-11T00:00:00.000Z");
const input: RunAttentionStepInput = {
  status: "running",
  startedAt: start,
  policy: DEFAULT_RUN_ATTENTION_POLICY,
  owner: "agent",
  attentionAt: null,
  humanNotifiedAt: null,
  noticeNextAt: null,
  now: start,
};
const at = (ms: number) => new Date(start.getTime() + ms);

describe("run attention boundaries", () => {
  it("validates strict independent policy and keeps 30 + 30 minutes", () => {
    expect(resolveRunAttentionPolicy(null)).toEqual({
      timeoutMs: 1_800_000,
      escalationMs: 1_800_000,
    });
    expect(resolveRunAttentionPolicy({ timeoutMs: 0, escalationMs: 1000 })).toEqual(
      DEFAULT_RUN_ATTENTION_POLICY,
    );
    expect(
      projectWakePolicySchema.safeParse({
        provider: "llm",
        configRevision: 1,
        thresholdVersion: "v1",
        runAttention: { timeoutMs: 1000, escalationMs: 2000 },
      }).success,
    ).toBe(true);
  });
  it("prioritizes terminal runs and absolute human deadline over a late owner retry", () => {
    expect(runAttentionStep({ ...input, now: at(1_799_999) })).toBe("pending");
    expect(runAttentionStep({ ...input, now: at(1_800_000) })).toBe("remind_owner");
    expect(runAttentionStep({ ...input, owner: "self", now: at(1_800_000) })).toBe(
      "mark_human_required",
    );
    expect(runAttentionStep({ ...input, owner: "human", now: at(1_800_000) })).toBe(
      "mark_human_required",
    );
    expect(
      runAttentionStep({
        ...input,
        attentionAt: at(1_900_000),
        noticeNextAt: at(3_599_999),
        now: at(3_600_000),
      }),
    ).toBe("notify_human");
    expect(runAttentionStep({ ...input, now: at(9_000_000) })).toBe("notify_human");
    expect(runAttentionStep({ ...input, status: "completed", now: at(9_000_000) })).toBe("done");
    expect(runAttentionStep({ ...input, humanNotifiedAt: at(3_600_000), now: at(9_000_000) })).toBe(
      "done",
    );
  });
  it("retries only when due and keeps terminal history without pending handling", () => {
    expect(
      runAttentionStep({
        ...input,
        attentionAt: at(1_800_000),
        noticeNextAt: at(1_810_000),
        now: at(1_809_999),
      }),
    ).toBe("pending");
    expect(
      runAttentionStep({
        ...input,
        attentionAt: at(1_800_000),
        noticeNextAt: at(1_810_000),
        now: at(1_810_000),
      }),
    ).toBe("retry_owner");
    const row = {
      status: "running",
      startedAt: start,
      attentionPolicySnapshot: DEFAULT_RUN_ATTENTION_POLICY,
      attentionAt: at(1_800_000),
      humanRequiredAt: at(1_800_000),
      humanNotifiedAt: null,
    } as typeof agentRun.$inferSelect;
    expect(runAttentionFacts(row, at(2_000_000))).toMatchObject({
      humanReminderAt: at(3_600_000).toISOString(),
      awaitingHandling: true,
    });
    expect(runAttentionFacts({ ...row, status: "aborted" }, at(9_000_000))).toMatchObject({
      attentionAt: at(1_800_000).toISOString(),
      awaitingHandling: false,
    });
    expect(runAttentionFacts({ ...row, startedAt: null }, at(9_000_000))).toBeNull();
  });
});
