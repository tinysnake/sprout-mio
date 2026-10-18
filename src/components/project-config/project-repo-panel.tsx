import { useState } from "react";
import type { ProjectRepoState } from "../../contracts/repository";
import { ID_PREFIXES, newId } from "../../contracts/ids";
import { toAppError } from "../../contracts/result";
import type { AppError } from "../../contracts/result";
import { Button } from "../ui/button";
import { ResultError } from "../project/result-error";
import { prepareProjectRepoFn } from "../../server/functions/repository";

const KIND_LABEL = {
  managed_clone: "宿主克隆",
  bound_copy: "本地副本（宿主复用）",
} as const;

function row(label: string, testId: string, value: string) {
  return (
    <div className="flex gap-2 text-sm">
      <dt className="w-28 shrink-0 text-muted-foreground">{label}</dt>
      <dd data-testid={testId} className="min-w-0 break-all">
        {value}
      </dd>
    </div>
  );
}

/** 只展示持久事实：来源、commit、ref、获取与解析时点、占用；不做本地推断。 */
export function ProjectRepoPanel({
  state,
  onRefresh,
}: {
  state: ProjectRepoState;
  onRefresh: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [fetched, setFetched] = useState(false);
  const [error, setError] = useState<AppError | null>(null);

  async function prepare() {
    if (pending) return;
    setPending(true);
    setError(null);
    setFetched(false);
    try {
      const result = await prepareProjectRepoFn({ data: { projectId: state.projectId } });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setFetched(true);
      onRefresh();
    } catch (cause) {
      setError(toAppError(cause, newId(ID_PREFIXES.request)));
    } finally {
      setPending(false);
    }
  }

  const checkout = state.checkout;
  return (
    <section aria-busy={pending} className="max-w-xl space-y-3" data-testid="repo-state">
      <h3 className="text-md font-semibold">仓库工作副本</h3>
      {row("托管目录", "repo-managed-root", state.managedRoot)}
      {row("磁盘上限", "repo-max-bytes", `${state.maxBytes} 字节`)}
      {checkout ? (
        <>
          {row("来源", "repo-source", checkout.source)}
          {row("类型", "repo-source-kind", KIND_LABEL[checkout.sourceKind])}
          {row("ref", "repo-ref", checkout.ref)}
          {row("commit", "repo-commit", checkout.commit)}
          {row(
            "获取时点",
            "repo-fetched-at",
            checkout.fetchedAt ?? "宿主未取过（沿用本地副本状态）",
          )}
          {row("解析时点", "repo-resolved-at", checkout.resolvedAt)}
          {row("占用", "repo-size", `${checkout.sizeBytes} 字节`)}
          {row("路径", "repo-path", checkout.path)}
          {row("状态", "repo-status", checkout.status === "ready" ? "就绪" : "准备中")}
        </>
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="repo-empty">
          尚未获取工作副本。绑定 gitRemote 后可按需克隆，或用 workDirectory 复用已有本地副本。
        </p>
      )}
      {error && <ResultError error={error} testId="repo-panel-error" />}
      <div className="flex items-center gap-3">
        <Button data-testid="repo-prepare" onClick={() => void prepare()} disabled={pending}>
          {pending ? "正在获取…" : "立即获取"}
        </Button>
        {fetched && (
          <span className="text-sm text-muted-foreground" data-testid="repo-prepared">
            已获取
          </span>
        )}
      </div>
    </section>
  );
}
