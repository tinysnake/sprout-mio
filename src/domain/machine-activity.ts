import { createHash } from "node:crypto";

const REVISION_LENGTH = 22;

/**
 * 页面上会显示、并且会自己变的事实。心跳类字段（`lastSeenAt`）刻意不在其中：
 * 它们每几秒就变一次，算进 revision 会让「变了才重读」退化成整页轮询。
 * 这与 `domain/info-hub.ts` 的 `VOLATILE_REVISION_KEYS` 是同一类判断，
 * 但这份投影是机器范围的最小集，不共用那边的 Hub 载荷。
 *
 * 这里不引入数据库模块：投影形状与 hash 保持可单测，读表留在 `domain/machine.ts`。
 */
export type MachineActivityFacts = {
  machine: {
    name: string;
    rootDirectory: string | null;
    rootRevision: number;
    updatedAt: string;
  } | null;
  bindings: { projectId: string; description: string; revision: number }[];
  /** `key` 是租约的复合身份（Project × Machine）：machine_lease 没有单列主键。 */
  leases: {
    key: string;
    generation: number;
    state: string;
    pendingMutationId: string | null;
  }[];
  executions: {
    projectId: string;
    id: string;
    state: string;
    /** 落定时刻取终态时间；未终态为空。remote_execution 没有名为 settledAt 的列。 */
    settledAt: string | null;
    cancellation: string | null;
  }[];
};

/**
 * 输入先按稳定键排序再 hash：同一批事实无论查询返回顺序如何都是同一个 revision。
 * 顺序不稳会让页面每轮都以为事实变了，等于又回到整页轮询。
 *
 * 只用 22 个 base64url 字符（132 位）：revision 只是变化信号，而这条轮询的响应
 * 必须整段落在 200 字节以内（server fn 的序列化包装本身就要一百多字节）。
 */
export function machineActivityDigest(facts: MachineActivityFacts): string {
  const stable = <T>(items: T[], key: (item: T) => string) =>
    [...items].sort((left, right) => key(left).localeCompare(key(right)));
  // 只取白名单字段：调用方多带一列（比如租约行上的 lastSeenAt）也不进入 hash。
  return createHash("sha256")
    .update(
      JSON.stringify({
        machine: facts.machine
          ? {
              name: facts.machine.name,
              rootDirectory: facts.machine.rootDirectory,
              rootRevision: facts.machine.rootRevision,
              updatedAt: facts.machine.updatedAt,
            }
          : null,
        bindings: stable(facts.bindings, (item) => item.projectId).map((item) => ({
          projectId: item.projectId,
          description: item.description,
          revision: item.revision,
        })),
        leases: stable(facts.leases, (item) => item.key).map((item) => ({
          key: item.key,
          generation: item.generation,
          state: item.state,
          pendingMutationId: item.pendingMutationId,
        })),
        executions: stable(facts.executions, (item) => `${item.projectId}:${item.id}`).map(
          (item) => ({
            projectId: item.projectId,
            id: item.id,
            state: item.state,
            settledAt: item.settledAt,
            cancellation: item.cancellation,
          }),
        ),
      }),
    )
    .digest("base64url")
    .slice(0, REVISION_LENGTH);
}
