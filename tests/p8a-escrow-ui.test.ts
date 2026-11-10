import { describe, expect, it } from "vite-plus/test";
import { leaseEscrowViewSchema, leaseViewSchema } from "../src/contracts/lease";
import {
  claimableEscrows,
  escrowClaimScope,
  escrowStateLabel,
  escrowTargetLabel,
  liveEscrowOf,
  liveEscrows,
  outboundEscrows,
} from "../src/components/machine/lease-view";
import {
  applyEscrowCommand,
  demoChannelEscrow,
  demoEscrowAgentNames,
  demoEscrowAgents,
  demoEscrowChats,
  demoEscrowInstances,
  demoEscrowLeases,
  demoEscrowProfiles,
  demoEscrowResult,
  demoEscrowSceneLeases,
  demoEscrowTargets,
  demoGroupEscrow,
  demoHolderChats,
  demoInstanceIds,
  demoLeases,
} from "../src/dev/scenes/machine/lease-fixtures";
import { demoProject, secondProject } from "../src/dev/scenes/machine/fixtures";

const names = {
  chats: {
    [demoEscrowTargets.group.chatId]: demoEscrowTargets.group.title,
    [demoEscrowTargets.channel.chatId]: demoEscrowTargets.channel.title,
  },
  chatKinds: {
    [demoEscrowTargets.group.chatId]: demoEscrowTargets.group.kind,
    [demoEscrowTargets.channel.chatId]: demoEscrowTargets.channel.kind,
  },
  agents: demoEscrowAgentNames,
};

// 挂靠演示数据必须满足共享契约：临界状态（已领取 / 已撤销）只在挂靠行的读取结果里出现。
describe("租约挂靠演示数据", () => {
  it("每条挂靠租约与挂靠行都通过共享 schema", () => {
    for (const lease of demoEscrowLeases) expect(() => leaseViewSchema.parse(lease)).not.toThrow();
    for (const escrow of Object.values(demoEscrowResult))
      expect(() => leaseEscrowViewSchema.parse(escrow)).not.toThrow();
  });

  it("挂靠不在 LeaseView 上留下终端状态", () => {
    for (const lease of demoEscrowLeases) expect(liveEscrowOf(lease)).not.toBeNull();
    expect(demoEscrowResult.les_33333333.state).toBe("claimed");
  });
});

describe("挂靠的只读投影", () => {
  it("只把挂靠中的租约算作活跃挂靠，并只投影本 Project", () => {
    const leases = [...demoLeases, ...demoEscrowLeases];
    expect(liveEscrows(leases, demoProject.id).map((lease) => lease.machineId)).toEqual(
      demoEscrowLeases.map((lease) => lease.machineId),
    );
    expect(liveEscrows(leases, secondProject.id)).toEqual([]);
  });

  it("领取候选只出现在挂靠目标那个 Chat", () => {
    const leases = [...demoLeases, ...demoEscrowLeases];
    expect(
      claimableEscrows(leases, demoProject.id, demoEscrowTargets.group.chatId).map(
        (lease) => lease.escrow?.escrowId,
      ),
    ).toEqual([demoGroupEscrow.escrowId]);
    expect(claimableEscrows(leases, demoProject.id, demoEscrowTargets.channel.chatId)).toHaveLength(
      1,
    );
    expect(claimableEscrows(leases, demoProject.id, demoEscrowTargets.dm.chatId)).toEqual([]);
  });

  it("撤销入口只跟着发起挂靠的分身所在的 Chat", () => {
    const leases = [...demoLeases, ...demoEscrowLeases];
    expect(
      outboundEscrows(leases, demoProject.id, [demoInstanceIds.primary]).map(
        (lease) => lease.escrow?.escrowId,
      ),
    ).toEqual([demoGroupEscrow.escrowId, demoChannelEscrow.escrowId]);
    expect(outboundEscrows(leases, demoProject.id, [demoInstanceIds.sibling])).toEqual([]);
  });

  it("指定 Agent 的挂靠只对该 profile 的分身可领取，且说明里写清原因", () => {
    const channel = demoEscrowInstances[demoEscrowTargets.channel.chatId];
    const group = demoEscrowInstances[demoEscrowTargets.group.chatId];
    expect(escrowClaimScope(demoChannelEscrow, channel, names).claimable).toBe(true);
    expect(escrowClaimScope(demoGroupEscrow, group, names).claimable).toBe(true);
    expect(escrowClaimScope(demoChannelEscrow, channel, names).note).toBeNull();
    expect(escrowClaimScope(demoChannelEscrow, [], names).note).toContain("文档 Agent");
  });

  it("目标文案只投影挂靠事实，名称取不到时退回 id", () => {
    expect(escrowTargetLabel(demoChannelEscrow, names)).toBe(
      "发布公告频道（Public Channel） · 指定 Agent 文档 Agent",
    );
    expect(escrowTargetLabel(demoGroupEscrow, names)).toBe("发布协作组（Group）");
    // 领取范围不是租约行要铺陈的事实：目标只留 Group 与可选的指定 Agent。
    expect(escrowTargetLabel(demoGroupEscrow, names)).not.toContain("该 Group 内任意分身可领取");
    expect(escrowTargetLabel(demoGroupEscrow)).toContain(demoEscrowTargets.group.chatId);
  });

  it("挂靠状态的标签覆盖四个终端态", () => {
    expect(escrowStateLabel("escrowed").label).toBe("挂靠中");
    expect(escrowStateLabel("claimed").label).toBe("已领取");
    expect(escrowStateLabel("cancelled").label).toBe("已撤销");
    expect(escrowStateLabel("superseded").label).toBe("已被取代");
  });
});

describe("挂靠命令的演示实现", () => {
  const target = demoLeases[0];

  it("挂靠推进一代，操作权交给目标 Group，持有者不变", () => {
    const result = applyEscrowCommand(
      demoLeases,
      {
        action: "escrow",
        projectId: target.projectId,
        machineId: target.machineId,
        requestId: "req_12345678",
        expectedGeneration: target.generation,
        chatId: demoEscrowTargets.group.chatId,
      },
      { instanceId: demoInstanceIds.primary },
    );
    if ("error" in result) throw new Error(result.error);
    const lease = result.leases.find((item) => item.machineId === target.machineId);
    expect(lease?.generation).toBe(target.generation + 1);
    expect(lease?.holderInstanceId).toBe(demoInstanceIds.primary);
    expect(lease?.escrow?.chatId).toBe(demoEscrowTargets.group.chatId);
    expect(result.receipt.escrowGeneration).toBe(target.generation + 1);
  });

  it("领取后租约换持有者，挂靠行收进收据", () => {
    const subject = demoEscrowLeases[0];
    const result = applyEscrowCommand(
      demoEscrowLeases,
      {
        action: "claim",
        projectId: subject.projectId,
        machineId: subject.machineId,
        requestId: "req_12345678",
        expectedGeneration: subject.generation,
        escrowId: demoGroupEscrow.escrowId,
      },
      { instanceId: demoInstanceIds.sibling },
    );
    if ("error" in result) throw new Error(result.error);
    const lease = result.leases.find((item) => item.machineId === subject.machineId);
    expect(lease?.holderInstanceId).toBe(demoInstanceIds.sibling);
    expect(lease?.escrow).toBeNull();
    expect(result.receipt.state).toBe("claimed");
    expect(result.receipt.claimedGeneration).toBe(subject.generation + 1);
  });

  it("撤销把租约还给发起者，Machine 没有被释放", () => {
    const subject = demoEscrowLeases[0];
    const result = applyEscrowCommand(
      demoEscrowLeases,
      {
        action: "escrow_cancel",
        projectId: subject.projectId,
        machineId: subject.machineId,
        requestId: "req_12345678",
        expectedGeneration: subject.generation,
        escrowId: demoGroupEscrow.escrowId,
      },
      { instanceId: demoInstanceIds.primary },
    );
    if ("error" in result) throw new Error(result.error);
    const lease = result.leases.find((item) => item.machineId === subject.machineId);
    expect(lease?.state).toBe("held");
    expect(lease?.holderInstanceId).toBe(demoInstanceIds.primary);
    expect(lease?.escrow).toBeNull();
    expect(result.receipt.state).toBe("cancelled");
  });

  it("非持有者不能挂靠，挂靠中的租约不能重复挂靠", () => {
    const stolen = applyEscrowCommand(
      demoLeases,
      {
        action: "escrow",
        projectId: demoProject.id,
        machineId: demoLeases[0].machineId,
        requestId: "req_12345678",
        expectedGeneration: demoLeases[0].generation,
        chatId: demoEscrowTargets.group.chatId,
      },
      { instanceId: demoInstanceIds.sibling },
    );
    expect("error" in stolen && stolen.error).toBe("lease_not_holder");
    const again = applyEscrowCommand(
      demoEscrowLeases,
      {
        action: "escrow",
        projectId: target.projectId,
        machineId: demoEscrowLeases[0].machineId,
        requestId: "req_12345678",
        expectedGeneration: demoEscrowLeases[0].generation,
        chatId: demoEscrowTargets.group.chatId,
      },
      { instanceId: demoInstanceIds.primary },
    );
    expect("error" in again && again.error).toBe("lease_conflict");
  });

  it("指定 Agent 的挂靠对不在范围内的分身不可领取", () => {
    const scope = escrowClaimScope(
      demoChannelEscrow,
      [{ agentProfileId: demoEscrowProfiles.reviewer }],
      names,
    );
    expect(scope.claimable).toBe(false);
    expect(demoEscrowProfiles.writer).toBe("agp_bbbbbbbb");
  });
});

describe("演示场景的挂靠数据", () => {
  it("切换到已挂靠场景后每个 Machine 仍然只有一行租约", () => {
    const keys = demoEscrowSceneLeases.map((lease) => `${lease.projectId}:${lease.machineId}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const lease of demoEscrowSceneLeases)
      expect(() => leaseViewSchema.parse(lease)).not.toThrow();
    expect(demoEscrowSceneLeases.filter((lease) => liveEscrowOf(lease) !== null)).toHaveLength(2);
  });

  it("挂靠目标选项把 DM 也列出来，指定 Agent 归属到它的 Chat", () => {
    expect(demoEscrowChats.map((chat) => chat.kind)).toEqual(["group", "public_channel", "dm"]);
    expect(demoEscrowChats.map((chat) => chat.id)).toEqual([
      demoEscrowTargets.group.chatId,
      demoEscrowTargets.channel.chatId,
      demoEscrowTargets.dm.chatId,
    ]);
    for (const agent of demoEscrowAgents) expect(agent.name).not.toBe(agent.agentProfileId);
    expect(demoEscrowAgents.map((agent) => agent.chatId)).toContain(demoEscrowTargets.group.chatId);
  });

  it("每个演示分身都能在自己的 Chat 里找到租约命令入口", () => {
    for (const id of [demoInstanceIds.primary, demoInstanceIds.sibling, demoInstanceIds.foreign])
      expect(demoHolderChats[id]?.chatId).toBeTruthy();
  });
});
