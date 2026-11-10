import { ID_PREFIXES, newId } from "../../contracts/ids";
import { sqlite } from "../../db";

export type FeishuLeaseDependencies = Readonly<{
  appId: string;
  now: () => Date;
  ttlMs?: number;
  holder?: string;
}>;

export type FeishuLease = Readonly<{
  holder: string;
  /** 抢占成功即返回 `acquired`，仍被活着的实例持有时返回 `held`。 */
  claim(): "acquired" | "held";
  /** 续约；返回 false 表示租约已被别人拿走，调用方必须停止服务。 */
  renew(): boolean;
  release(): void;
}>;

const DEFAULT_TTL_MS = 20_000;

/**
 * 一条语句完成抢占与续约：持有者是自己、或原租约已过期时写入成功，一行都没改
 * 说明别的活实例还握着它。SQLite 保证单条语句原子，跨进程也不会两边都成功。
 */
const TAKEOVER = `INSERT INTO feishu_connection_lease(app_id, holder, expires_at_ms)
VALUES(?, ?, ?)
ON CONFLICT(app_id) DO UPDATE SET
  holder = excluded.holder,
  expires_at_ms = excluded.expires_at_ms
WHERE feishu_connection_lease.holder = excluded.holder
   OR feishu_connection_lease.expires_at_ms <= ?`;

export function createFeishuLease(dependencies: FeishuLeaseDependencies): FeishuLease {
  const ttlMs = dependencies.ttlMs ?? DEFAULT_TTL_MS;
  const holder = dependencies.holder ?? newId(ID_PREFIXES.request);
  const takeover = sqlite.prepare(TAKEOVER);
  const drop = sqlite.prepare(
    "DELETE FROM feishu_connection_lease WHERE app_id = ? AND holder = ?",
  );

  const take = (): boolean => {
    const at = dependencies.now().getTime();
    return takeover.run(dependencies.appId, holder, at + ttlMs, at).changes === 1;
  };

  return {
    holder,
    claim: () => (take() ? "acquired" : "held"),
    renew: take,
    release: () => {
      drop.run(dependencies.appId, holder);
    },
  };
}
