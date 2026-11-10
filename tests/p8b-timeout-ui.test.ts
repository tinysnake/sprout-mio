import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { leaseEscrowViewSchema, leaseViewSchema } from "../src/contracts/lease";
import { leaseStatusLabel } from "../src/components/machine/lease-view";
import {
  LEASE_TIMEOUT_LABELS,
  leaseTimeoutPhase,
} from "../src/components/machine/lease-timeout-view";
import {
  LEASE_TIMEOUT_SENDER_ID,
  LEASE_TIMEOUT_SENDER_NAME,
  isLeaseTimeoutSender,
} from "../src/components/chat/lease-timeout-message";
import {
  demoTimeoutEscrows,
  demoTimeoutSceneLeases,
} from "../src/dev/scenes/machine/lease-fixtures";
import { demoProject } from "../src/dev/scenes/machine/fixtures";

/**
 * I-P8b 的呈现契约：超时只加只读标记、绝不显示成空闲；提醒消息如实呈现为一条消息；
 * 租约行只留状态事实，不铺陈时限、提醒与处理说明。
 */

const timeoutOf = (name: keyof typeof demoTimeoutEscrows) => demoTimeoutEscrows[name].timeout;

describe("挂靠超时的相位只读契约事实", () => {
  it("超时相位只看契约字段，不看客户端时钟", () => {
    // 这是「界面不许自己造倒计时」的守卫：deadlineAt 早就过了，但 sweep 还没把
    // awaitingHandling 立起来，界面就必须仍然读成「没有超时」。
    expect(
      leaseTimeoutPhase({
        deadlineAt: "2000-01-01T00:00:00.000Z",
        notifiedAt: null,
        escalatedAt: null,
        awaitingHandling: false,
        ownerAutoAttemptsPaused: false,
      }),
    ).toBe("none");
  });

  it("awaitingHandling 与 escalatedAt 分别给出未处理与已升级两个相位", () => {
    expect(leaseTimeoutPhase(timeoutOf("humanOwner"))).toBe("awaiting");
    expect(leaseTimeoutPhase(timeoutOf("agentOwner"))).toBe("awaiting");
    expect(leaseTimeoutPhase(timeoutOf("escalated"))).toBe("escalated");
    expect(leaseTimeoutPhase(timeoutOf("waiting"))).toBe("none");
  });

  it("已升级的挂靠不允许停留在待处理相位", () => {
    // 契约 superRefine 保证 escalatedAt 非空 ⇒ ownerAutoAttemptsPaused；
    // 相位判定里 escalatedAt 优先，所以这个组合只能是 escalated。
    expect(
      leaseTimeoutPhase({
        deadlineAt: "2026-10-18T09:30:00.000Z",
        notifiedAt: "2026-10-18T09:30:00.000Z",
        escalatedAt: "2026-10-18T11:30:00.000Z",
        awaitingHandling: true,
        ownerAutoAttemptsPaused: true,
      }),
    ).toBe("escalated");
  });
});

describe("超时未处理的租约不会显示成空闲", () => {
  const leaseWith = (escrow: (typeof demoTimeoutEscrows)[keyof typeof demoTimeoutEscrows]) => ({
    projectId: demoProject.id,
    machineId: escrow.machineId,
    generation: 6,
    state: "held" as const,
    holderInstanceId: escrow.escrowedByInstanceId,
    changedAt: escrow.escrowedAt,
    pendingMutationId: null,
    escrow,
  });

  it("超时与已升级都并入状态位，且不出现「空闲」", () => {
    const awaiting = leaseStatusLabel(leaseWith(demoTimeoutEscrows.humanOwner));
    expect(awaiting.label).toBe(`挂靠中 · ${LEASE_TIMEOUT_LABELS.awaiting.label}`);
    expect(awaiting.label).not.toContain("空闲");

    const escalated = leaseStatusLabel(leaseWith(demoTimeoutEscrows.escalated));
    expect(escalated.label).toBe(`挂靠中 · ${LEASE_TIMEOUT_LABELS.escalated.label}`);
    expect(escalated.label).not.toContain("空闲");

    // 说明行删掉之后，严重程度由状态位自己承担，不能再退回「挂靠中」的平和语气。
    expect(awaiting.tone).toBe("warning");
    expect(escalated.tone).toBe("danger");
    expect(LEASE_TIMEOUT_LABELS.awaiting.tone).toBe("warning");
    expect(LEASE_TIMEOUT_LABELS.escalated.tone).toBe("danger");
  });

  it("还没到时限的挂靠保持朴素的状态位", () => {
    const status = leaseStatusLabel(leaseWith(demoTimeoutEscrows.waiting));
    expect(status.label).toBe("挂靠中");
  });
});

describe("挂靠超时提醒在界面上是一条消息", () => {
  it("提醒的 sender 约定只命中保留 id", () => {
    expect(isLeaseTimeoutSender("agent", LEASE_TIMEOUT_SENDER_ID)).toBe(true);
    expect(isLeaseTimeoutSender("human", LEASE_TIMEOUT_SENDER_ID)).toBe(false);
    expect(isLeaseTimeoutSender("agent", "agt_demo_reviewer")).toBe(false);
  });

  it("UI 侧的重声明与域层常量一致", () => {
    const source = readFileSync(new URL("../src/domain/lease-timeout.ts", import.meta.url), "utf8");
    expect(source).toContain(
      `export const LEASE_TIMEOUT_SENDER_ID = "${LEASE_TIMEOUT_SENDER_ID}";`,
    );
  });

  it("界面不替提醒声明唤醒行为，唤醒口径只属于域层正文", () => {
    // 域层只对**人类 owner** 的正文写「不触发唤醒」，对 agent owner 是直接唤醒：
    // 界面再加一条统一声明，就等于把 agent owner 那条说反了。
    const domain = readFileSync(new URL("../src/domain/lease-timeout.ts", import.meta.url), "utf8");
    expect(domain).toContain("不触发唤醒、也不触发自动接续");
    expect(domain).toContain('if (owner.kind !== "agent") return { ok: true };');

    // 界面自己只负责把这条消息渲染出来，名字里不许带唤醒口径。
    expect(LEASE_TIMEOUT_SENDER_NAME).toBe("挂靠超时提醒");
    expect(LEASE_TIMEOUT_SENDER_NAME).not.toContain("唤醒");
    const ui = readFileSync(
      new URL("../src/components/chat/lease-timeout-message.ts", import.meta.url),
      "utf8",
    );
    expect(ui).not.toContain("不触发唤醒");
  });
});

describe("租约行只留状态事实，不再铺陈时限与处理说明", () => {
  it("被删掉的解释性文案不会回到租约界面", () => {
    const read = (path: string) =>
      readFileSync(new URL(`../src/components/machine/${path}`, import.meta.url), "utf8");
    // 只扫真正渲染文案的两个文件；映射模块顶部的注释解释了 why，本身不是界面文案。
    const sources = [read("lease-panel.tsx"), read("lease-view.ts")].join("\n");
    for (const phrase of [
      "挂靠时限",
      "升级时限",
      "提醒尚未发出",
      "自动尝试已暂停",
      "处理沿用既有的租约动作",
      "不是同一个倒计时",
      "拿不到 Machine",
      "该 Group 内任意分身可领取",
    ]) {
      expect(sources).not.toContain(phrase);
    }
  });

  it("超时事实组件与只给说明行用的映射一起删除，不留死代码", () => {
    expect(() =>
      readFileSync(
        new URL("../src/components/machine/lease-timeout-facts.tsx", import.meta.url),
        "utf8",
      ),
    ).toThrow();
    const view = readFileSync(
      new URL("../src/components/machine/lease-timeout-view.ts", import.meta.url),
      "utf8",
    );
    for (const gone of ["detail", "leaseWaitReason", "LEASE_WAIT_FAILURE_LABELS", "durationText"]) {
      expect(view).not.toContain(gone);
    }
  });

  it("状态位文案里不出现「空闲」或时限数字", () => {
    for (const lease of demoTimeoutSceneLeases.filter((item) => item.escrow)) {
      const label = leaseStatusLabel(lease).label;
      expect(label).not.toContain("空闲");
      expect(label).not.toMatch(/分钟|小时|秒/);
    }
  });
});

describe("挂靠超时演示场景覆盖五种形态", () => {
  it("演示数据全部通过契约校验", () => {
    for (const escrow of Object.values(demoTimeoutEscrows)) {
      const result = leaseEscrowViewSchema.safeParse(escrow);
      if (!result.success)
        throw new Error(`挂靠演示数据未通过契约：${escrow.escrowId}\n${result.error}`);
    }
    for (const lease of demoTimeoutSceneLeases) {
      const result = leaseViewSchema.safeParse(lease);
      if (!result.success)
        throw new Error(`租约演示数据未通过契约：${lease.machineId}\n${result.error}`);
    }
  });

  it("四条活跃挂靠分别是：人类 owner 超时、Agent owner 超时、已升级、等待中", () => {
    const phases = demoTimeoutSceneLeases
      .filter((lease) => lease.escrow)
      .map((lease) => leaseTimeoutPhase(lease.escrow!.timeout));
    expect(phases).toEqual(["awaiting", "awaiting", "escalated", "none"]);
  });

  it("已升级的那条同时给出暂停自动尝试的事实", () => {
    const escalated = demoTimeoutSceneLeases.filter(
      (lease) => lease.escrow?.state === "escrowed" && lease.escrow.timeout.escalatedAt !== null,
    );
    expect(escalated).toHaveLength(1);
    expect(escalated[0]!.escrow!.timeout.ownerAutoAttemptsPaused).toBe(true);
  });

  it("领取之后的 Machine 不再带挂靠，也不再显示超时", () => {
    const claimed = demoTimeoutSceneLeases.find((lease) => lease.escrow === null);
    expect(claimed).toBeDefined();
    expect(leaseStatusLabel(claimed!).label).toBe("持有中");
    expect(claimed!.generation).toBeGreaterThan(demoTimeoutEscrows.escalated.escrowGeneration);
  });
});
