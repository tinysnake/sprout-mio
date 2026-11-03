import { ID_PREFIXES, newId } from "../contracts/ids";
import { db, sqlite } from "../db";
import { diagnosticEvent } from "../db/schema";
import type { ProjectContext } from "./access";
import { publishProjectChange } from "./change-feed";

export type IdentityWriteHooks = { afterWrite?: () => void };
type IdentityDiagnostic = {
  event: string;
  message: string;
  projectId?: string;
  chatId?: string;
  instanceId?: string;
};

export function writeIdentity<T>(
  ctx: ProjectContext,
  diagnostic: IdentityDiagnostic,
  write: () => T,
  hooks: IdentityWriteHooks,
): T {
  return sqlite
    .transaction(() => {
      const result = write();
      hooks.afterWrite?.();
      db.insert(diagnosticEvent)
        .values({
          id: newId(ID_PREFIXES.diagnostic),
          at: new Date(),
          level: "info",
          requestId: ctx.requestId,
          ...diagnostic,
        })
        .run();
      // 推送由合窗定时器在提交之后补发；事务回滚最多让页面多读一次 revision。
      publishProjectChange(diagnostic.projectId ?? "", diagnostic.chatId);
      return result;
    })
    .immediate();
}
