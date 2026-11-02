import { beforeAll, describe, expect, it } from "vite-plus/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

type Evidence = {
  groupWake: boolean;
  group: {
    candidates: number;
    recipient: string;
    state: string;
    bound: boolean;
    source: string;
    taskIds: string[];
  };
  multi: { selected: number; deliveries: { recipient_id: string; state: string }[] };
  fallback: { selected: { kind: string; id: string }[]; delivery: { recipient_id: string; state: string } };
  public: { policy: string; wake: boolean };
  mention: { wake: boolean; runs: number };
  ownerLed: { wake: boolean; runs: number };
  dm: { wake: boolean; runs: number };
  debounce: { rows: number; trigger: boolean; capped: boolean };
  taskActive: { claimed: boolean; queued: boolean; postponed: boolean };
  sources: {
    blocked: boolean;
    messageStillClaimed: boolean;
    messageRound: number;
    taskRound: number;
    scheduleRound: number;
  };
  failureFallback: { attempts: number; recipient: string; state: string; reasonCode: string };
  owner: string;
  disabled: { wake: number; runs: number };
  race: { blocked: boolean; trigger: boolean; oldState: string; first: string };
};

let evidence: Evidence;

function runFixture(directory: string, file: string, env: Record<string, string>) {
  const output = execFileSync(process.execPath, ["--import", "tsx", file], {
    cwd: resolve("."),
    env: {
      ...process.env,
      DATABASE_URL: join(directory, `${file.split("/").at(-1)}.sqlite`),
      SPROUT_PI_ENABLED: "false",
      BETTER_AUTH_SECRET: "x".repeat(64),
      ...env,
    },
    encoding: "utf8",
  });
  return JSON.parse(output.trim().split("\n").at(-1)!);
}

beforeAll(() => {
  mkdirSync(".verify", { recursive: true });
  const directory = mkdtempSync(resolve(".verify/message-wake-test-"));
  try {
    evidence = runFixture(directory, "tests/fixtures/message-wake.ts", {});
    evidence.disabled = runFixture(
      directory,
      "tests/fixtures/message-wake-disabled.ts",
      { SPROUT_AUTOMATION_ENABLED: "false" },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("message-triggered wake", () => {
  it("turns a plain contextual group message into one evaluation and one delivery", () => {
    expect(evidence.groupWake).toBe(true);
    expect(evidence.group.candidates).toBe(2);
    expect(evidence.group.state).toBe("bound");
    expect(evidence.group.bound).toBe(true);
    expect(evidence.group.source).toBe("message");
    expect(evidence.group.taskIds).toEqual([]);
  });

  it("delivers to every selected agent without the old per-chat uniqueness limit", () => {
    expect(evidence.multi.selected).toBe(2);
    expect(evidence.multi.deliveries).toHaveLength(2);
    expect(evidence.multi.deliveries.every((row) => row.state === "bound")).toBe(true);
  });

  it("falls back to the agent owner when the evaluator selects nobody", () => {
    expect(evidence.fallback.selected).toHaveLength(1);
    expect(evidence.fallback.delivery.recipient_id).toBe(evidence.fallback.selected[0]!.id);
    expect(["pending", "bound"]).toContain(evidence.fallback.delivery.state);
  });

  it("applies to public channels but not to explicit mentions, owner_led or DMs", () => {
    expect(evidence.public).toEqual({ policy: "contextual", wake: true });
    expect(evidence.mention.wake).toBe(false);
    expect(evidence.mention.runs).toBeGreaterThan(0);
    expect(evidence.ownerLed.wake).toBe(false);
    expect(evidence.ownerLed.runs).toBeGreaterThan(0);
    expect(evidence.dm.wake).toBe(false);
    expect(evidence.dm.runs).toBeGreaterThan(0);
  });

  it("lets a newer message replace a retrying evaluation without losing its trigger", () => {
    expect(evidence.race.blocked).toBe(true);
    expect(evidence.race.trigger).toBe(true);
    expect(evidence.race.oldState).toBe("stale");
  });

  it("keeps direct owner wake when automation is disabled", () => {
    expect(evidence.disabled.wake).toBe(0);
    expect(evidence.disabled.runs).toBeGreaterThan(0);
  });

  it("debounces consecutive messages into one capped wake", () => {
    expect(evidence.debounce.rows).toBe(1);
    expect(evidence.debounce.trigger).toBe(true);
    expect(evidence.debounce.capped).toBe(true);
  });

  it("queues behind an active task evaluation instead of claiming it", () => {
    expect(evidence.taskActive.claimed).toBe(false);
    expect(evidence.taskActive.queued).toBe(true);
    expect(evidence.taskActive.postponed).toBe(true);
  });

  it("shares one round counter between message and task evaluations", () => {
    expect(evidence.sources.blocked).toBe(true);
    expect(evidence.sources.messageStillClaimed).toBe(true);
    expect(evidence.sources.messageRound).toBe(1);
    expect(evidence.sources.taskRound).toBe(2);
    expect(evidence.sources.scheduleRound).toBe(2);
  });

  it("falls back to the owner after the evaluator exhausts its retries", () => {
    expect(evidence.failureFallback.attempts).toBe(3);
    expect(evidence.failureFallback.recipient).toBe(evidence.owner);
    expect(evidence.failureFallback.reasonCode).toBe("owner_fallback");
    expect(["pending", "bound"]).toContain(evidence.failureFallback.state);
  });
});
