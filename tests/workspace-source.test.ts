import { describe, expect, it } from "vite-plus/test";
import { leaseViewSchema } from "../src/contracts/lease";
import { leasesByRecency } from "../src/components/machine/lease-view";
import { fileUrlOf, treeUrlOf, viewerUrlOf } from "../src/components/workspace/workspace-api";

const projectId = "prj_1234abcd";
const chatId = "cnv_1234abcd";
const machineId = "mch_1234abcd";

describe("文件来源拼 URL", () => {
  it("本机工作区的树与字节都带 chatId", () => {
    const source = { kind: "workspace", projectId, chatId } as const;
    expect(treeUrlOf(source, "")).toBe(
      `/api/workspace/tree?projectId=${projectId}&path=&chatId=${chatId}`,
    );
    expect(fileUrlOf(source, "docs/a.md")).toContain("path=docs%2Fa.md");
    expect(fileUrlOf(source, "docs/a.md")).toContain(`chatId=${chatId}`);
  });

  it("没有 Chat 的工作区请求不编造 chatId", () => {
    const source = { kind: "workspace", projectId } as const;
    expect(treeUrlOf(source, "src")).not.toContain("chatId=");
  });

  it("机器来源换成 machineId，绝不带 chatId", () => {
    const source = { kind: "machine", projectId, machineId } as const;
    const url = treeUrlOf(source, "logs");
    expect(url.startsWith("/api/machine/tree?")).toBe(true);
    expect(url).toContain(`machineId=${machineId}`);
    expect(url).not.toContain("chatId=");
    expect(fileUrlOf(source, "a.png").startsWith("/api/machine/file?")).toBe(true);
  });

  it("新标签页指向应用页面而不是字节接口", () => {
    expect(viewerUrlOf({ kind: "workspace", projectId, chatId }, "README.md")).toBe(
      `/projects/${projectId}/files?path=README.md&chatId=${chatId}`,
    );
    expect(viewerUrlOf({ kind: "machine", projectId, machineId }, "docs/a.csv", chatId)).toBe(
      `/projects/${projectId}/machines/${machineId}/files?path=docs%2Fa.csv&chatId=${chatId}`,
    );
    expect(viewerUrlOf({ kind: "machine", projectId, machineId }, "docs/a.csv")).not.toContain(
      "chatId=",
    );
  });
});

describe("租约按最近一次变化排序", () => {
  const lease = (machineId: string, changedAt: string) =>
    leaseViewSchema.parse({
      projectId,
      machineId,
      generation: 0,
      state: "free",
      holderInstanceId: null,
      ownerKind: null,
      holderCrewChatId: null,
      changedAt,
      pendingMutationId: null,
      escrow: null,
      grant: null,
    });

  it("申请或释放得越晚越靠前，且不改原数组顺序", () => {
    const older = lease("mch_aaaaaaaa", "2026-11-14T10:00:00.000Z");
    const newer = lease("mch_bbbbbbbb", "2026-11-15T09:00:00.000Z");
    const original = [older, newer];
    expect(leasesByRecency(original).map((item) => item.machineId)).toEqual([
      "mch_bbbbbbbb",
      "mch_aaaaaaaa",
    ]);
    expect(original.map((item) => item.machineId)).toEqual(["mch_aaaaaaaa", "mch_bbbbbbbb"]);
  });
});
