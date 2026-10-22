import { useState } from "react";
import type { ReactNode } from "react";
import type { AppResult } from "../../contracts/result";
import type { ProjectRepoState } from "../../contracts/repository";
import { ID_PREFIXES, newId } from "../../contracts/ids";
import { toAppError } from "../../contracts/result";
import type { AppError } from "../../contracts/result";
import { Button } from "../ui/button";
import { ResultError } from "../project/result-error";
import { Facts, SettingsSection } from "../project/settings-section";
const KIND_LABEL = {
  managed_clone: "宿主克隆",
  bound_copy: "本地副本（宿主复用）",
} as const;

function moment(value: string | undefined, fallback: string): ReactNode {
  if (!value) return fallback;
  return (
    <time dateTime={value} title={value} suppressHydrationWarning>
      {new Date(value).toLocaleString("zh-CN", { hour12: false })}
    </time>
  );
}

/**
 * 只展示持久事实：来源、commit、ref、获取与解析时点、占用；不做本地推断。
 * 获取动作由调用方注入，正式页面接 prepareProjectRepo。
 */
export function ProjectRepoPanel({
  state,
  prepare,
  onRefresh,
}: {
  state: ProjectRepoState;
  prepare: () => Promise<AppResult<unknown>>;
  onRefresh: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [fetched, setFetched] = useState(false);
  const [error, setError] = useState<AppError | null>(null);

  async function handlePrepare() {
    if (pending) return;
    setPending(true);
    setError(null);
    setFetched(false);
    try {
      const result = await prepare();
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
    <div data-testid="repo-state" aria-busy={pending}>
      <SettingsSection
        title="仓库工作副本"
        description="Chat 的仓库依据取自这里；来源与 commit 都是宿主记录的事实。"
        actions={
          <>
            <Button
              data-testid="repo-prepare"
              loading={pending}
              onClick={() => void handlePrepare()}
            >
              {pending ? "正在获取…" : "立即获取"}
            </Button>
            {fetched && (
              <span
                role="status"
                data-testid="repo-prepared"
                className="text-xs text-muted-foreground"
              >
                已获取
              </span>
            )}
          </>
        }
      >
        <div className="flex max-w-[40rem] flex-col gap-4">
          <Facts
            items={[
              {
                label: "托管目录",
                testId: "repo-managed-root",
                value: <code className="font-mono text-[0.6875rem]">{state.managedRoot}</code>,
              },
              {
                label: "磁盘上限",
                testId: "repo-max-bytes",
                value: `${state.maxBytes} 字节`,
              },
            ]}
          />
          {checkout ? (
            <Facts
              items={[
                { label: "来源", testId: "repo-source", value: checkout.source },
                {
                  label: "类型",
                  testId: "repo-source-kind",
                  value: KIND_LABEL[checkout.sourceKind],
                },
                { label: "ref", testId: "repo-ref", value: checkout.ref },
                {
                  label: "commit",
                  testId: "repo-commit",
                  value: <code className="font-mono text-[0.6875rem]">{checkout.commit}</code>,
                },
                {
                  label: "获取时点",
                  testId: "repo-fetched-at",
                  value: moment(checkout.fetchedAt, "宿主未取过（沿用本地副本状态）"),
                },
                {
                  label: "解析时点",
                  testId: "repo-resolved-at",
                  value: moment(checkout.resolvedAt, "未解析"),
                },
                { label: "占用", testId: "repo-size", value: `${checkout.sizeBytes} 字节` },
                {
                  label: "路径",
                  testId: "repo-path",
                  value: <code className="font-mono text-[0.6875rem]">{checkout.path}</code>,
                },
                {
                  label: "状态",
                  testId: "repo-status",
                  value: checkout.status === "ready" ? "就绪" : "准备中",
                },
              ]}
            />
          ) : (
            <p className="text-xs leading-6 text-muted-foreground" data-testid="repo-empty">
              尚未获取工作副本。绑定 Git remote 后可按需克隆，或用工作目录复用已有本地副本。
            </p>
          )}
          {error && <ResultError error={error} testId="repo-panel-error" />}
        </div>
      </SettingsSection>
    </div>
  );
}
