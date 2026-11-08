import { describe, expect, it } from "vite-plus/test";
import {
  webhookActionSchema,
  webhookRuleDraftSchema,
  webhookTriggerSchema,
} from "../src/contracts/automation";

const chatId = "cnv_12345678";
const agentProfileId = "agp_12345678";
const base = {
  projectId: "prj_12345678",
  name: "Alert",
  instruction: "Inspect this notification.",
};

describe("webhook action contracts", () => {
  it("requires an explicit recipient policy rather than accepting arbitrary sender or target data", () => {
    expect(webhookActionSchema.parse({ kind: "dm_agent", chatId, agentProfileId })).toEqual({
      kind: "dm_agent",
      chatId,
      agentProfileId,
    });
    expect(
      webhookActionSchema.safeParse({ kind: "dm_agent", chatId, agentProfileId, senderId: "user" })
        .success,
    ).toBe(false);
    expect(
      webhookActionSchema.safeParse({ kind: "group_owner", chatId, agentProfileId }).success,
    ).toBe(false);
  });

  it("accepts only one of the three fixed Chat delivery modes", () => {
    for (const action of [
      { kind: "dm_agent", chatId, agentProfileId },
      { kind: "group_agent", chatId, agentProfileId },
      { kind: "group_owner", chatId },
    ]) {
      expect(webhookRuleDraftSchema.safeParse({ ...base, action }).success).toBe(true);
    }
    expect(
      webhookRuleDraftSchema.safeParse({ ...base, action: { kind: "broadcast", chatId } }).success,
    ).toBe(false);
  });

  it("keeps skipped receipt reasons explicit without implying message or run success", () => {
    const trigger = {
      id: "wht_12345678",
      ruleId: "whr_12345678",
      mode: "live",
      eventId: "provider-evt-1",
      decision: "skipped",
      reason: "target_not_participating",
      createdAt: "2026-11-08T00:00:00.000Z",
    };
    expect(webhookTriggerSchema.parse(trigger)).toEqual(trigger);
    expect(
      webhookTriggerSchema.safeParse({ ...trigger, decision: "accepted", reason: undefined })
        .success,
    ).toBe(false);
    expect(webhookTriggerSchema.safeParse({ ...trigger, messageId: "msg_12345678" }).success).toBe(
      false,
    );
    const { reason: _reason, ...accepted } = {
      ...trigger,
      decision: "accepted",
      messageId: "msg_12345678",
    };
    expect(webhookTriggerSchema.safeParse(accepted).success).toBe(true);
  });
});
