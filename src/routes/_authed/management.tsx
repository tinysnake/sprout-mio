import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ThemeMenuToggle } from "../../components/layout/theme-toggle";
import { Button } from "../../components/ui/button";
import { authenticate } from "../../server/session";
import { clearOfflineReads } from "../../lib/pwa";

type Health = {
  version: string;
  phase: string;
  activeBackgroundTasks: number;
  database: { ok: boolean; migrationApplied: boolean };
};
type Summary = {
  asOf: string;
  migration: { id: number; hash: string; journalTimestamp: number } | null;
  pendingResourceNotices: number;
  pendingContinuations: number;
  mcpFrames: { state: string; count: number; bytes: number }[];
};
export const Route = createFileRoute("/_authed/management")({ component: Management });

function Management() {
  const { human } = Route.useRouteContext();
  const router = useRouter();
  const [health, setHealth] = useState<Health | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [updated, setUpdated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const [response, diagnostics] = await Promise.all([
          fetch("/api/health", { signal: controller.signal }),
          fetch("/api/diagnostics?summary=1", { signal: controller.signal }),
        ]);
        const body = await response.json();
        const detail = await diagnostics.json();
        if (!response.ok) throw new Error("服务尚未就绪，请查看诊断日志");
        if (!diagnostics.ok || !detail.ok)
          throw new Error(
            diagnostics.status === 401 ? "登录已失效，请重新登录" : "诊断摘要读取失败",
          );
        setSummary(detail.data);
        setHealth(body);
        setUpdated(new Date(detail.data.asOf).toLocaleString());
        setError(null);
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "读取失败");
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    window.addEventListener("online", refresh);
    return () => {
      controller.abort();
      clearInterval(timer);
      window.removeEventListener("online", refresh);
    };
  }, []);
  async function signOut() {
    if (pending) return;
    if (!navigator.onLine) {
      setError("离线，登出未提交，请联网后重试");
      return;
    }
    setPending(true);
    try {
      const result = await authenticate({ data: { action: "logout" } });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      clearOfflineReads();
      await router.invalidate();
      await router.navigate({ to: "/login", search: { next: "/" } });
    } catch {
      setError("登出结果未知，请刷新确认登录状态");
    } finally {
      setPending(false);
    }
  }
  return (
    <div
      data-testid="management-page"
      className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4 sm:p-6"
    >
      <div className="mx-auto w-full max-w-3xl space-y-6">
        <header>
          <h1 className="text-xl font-semibold">Management</h1>
          <p className="mt-1 text-sm text-muted-foreground">服务、数据与个人偏好</p>
        </header>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
            {updated ? ` · 最后更新 ${updated}` : ""}
          </p>
        )}
        <section
          aria-labelledby="service-heading"
          className="space-y-4 rounded-container border border-border bg-card p-4"
        >
          <h2 id="service-heading" className="font-semibold">
            服务与数据
          </h2>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm">
            <dt>服务版本</dt>
            <dd data-testid="service-version" className="break-all">
              {health?.version ?? "读取中…"}
            </dd>
            <dt>服务状态</dt>
            <dd>{health?.phase ?? "尚未读取"}</dd>
            <dt>数据库迁移</dt>
            <dd data-testid="migration-version" className="break-all">
              {health ? (health.database.migrationApplied ? "已应用" : "未应用") : "尚未读取"}
              {summary?.migration
                ? ` · 记录 #${summary.migration.id} · ${summary.migration.hash.slice(0, 16)}`
                : ""}
            </dd>
            <dt>后台任务</dt>
            <dd data-testid="background-tasks">{health?.activeBackgroundTasks ?? "尚未读取"}</dd>
            <dt>待交付事件 / 续行</dt>
            <dd data-testid="event-backlog">
              {summary
                ? `${summary.pendingResourceNotices} 个资源事件 · ${summary.pendingContinuations} 个续行（pending / bound）`
                : "尚未读取"}
            </dd>
            <dt>MCP 队列水位</dt>
            <dd data-testid="queue-watermark">
              {summary
                ? ["queued", "sent", "unknown"]
                    .map((state) => {
                      const row = summary.mcpFrames.find((row) => row.state === state);
                      return `${state} ${row?.count ?? 0} 帧 / ${row?.bytes ?? 0} B`;
                    })
                    .join(" · ")
                : "尚未读取"}
            </dd>
          </dl>
          <p className="text-xs text-muted-foreground">
            队列摘要仅含当前账号 Project 的资源通知、续行与 MCP 帧；sent 等待确认，unknown
            表示交付结果未知。
          </p>
          {updated && <p className="text-xs text-muted-foreground">最后更新 {updated}</p>}
          <div id="backup-restore" className="space-y-2 border-t border-border pt-4 text-sm">
            <h3 className="font-medium">备份与恢复</h3>
            <p>
              由服务部署者在宿主机操作。先停止服务与写入，备份 DATABASE_URL 指向的 SQLite
              数据库（默认
              data/sprout.sqlite）及相关数据目录，保留配置与密钥。恢复前另存当前数据，恢复备份后启动服务并检查迁移、登录与对象详情。
            </p>
            <p className="text-muted-foreground">
              此页面提供操作说明；备份文件与恢复操作在服务宿主机上完成。
            </p>
            <a
              href="/api/health"
              target="_blank"
              rel="noreferrer"
              className="text-primary underline"
            >
              查看服务与迁移检查
            </a>
          </div>
          <div className="space-y-2 border-t border-border pt-4 text-sm">
            <h3 className="font-medium">日志与诊断</h3>
            <p>
              服务日志输出到宿主进程的标准输出与标准错误，由部署者的进程管理器收集。诊断事件保存在应用数据库，可用错误提示中的
              requestId 查询。
            </p>
            <form
              action="/api/diagnostics"
              target="_blank"
              className="flex flex-wrap items-end gap-2"
            >
              <label className="min-w-0 flex-1">
                requestId
                <input
                  name="requestId"
                  required
                  value={requestId}
                  onChange={(event) => setRequestId(event.target.value)}
                  className="mt-1 block w-full rounded-control border border-input bg-background px-3 py-2"
                />
              </label>
              <Button type="submit" variant="outline">
                打开诊断事件
              </Button>
            </form>
          </div>
        </section>
        <section
          aria-labelledby="account-heading"
          className="space-y-3 rounded-container border border-border bg-card p-4"
        >
          <h2 id="account-heading" className="font-semibold">
            账号与外观
          </h2>
          <p className="break-all text-sm">
            {human?.name} · {human?.email}
          </p>
          <ThemeMenuToggle />
          <Button variant="outline" disabled={pending} onClick={() => void signOut()}>
            {pending ? "登出中…" : "登出"}
          </Button>
        </section>
      </div>
    </div>
  );
}
