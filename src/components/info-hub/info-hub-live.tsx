import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { InfoHubQuery, InfoHubView } from "../../contracts/info-hub-query";
import type { InfoHubRefreshInput, InfoHubRefreshResult } from "../../contracts/info-hub-query";
import type { InfoHubResult } from "../../contracts/info-hub";
import { useInfoHubPolling } from "./use-info-hub-polling";

/** 刷新走哪条链路由路由决定：真实页面传 server function，组件自己不选 transport。 */
export type InfoHubRefreshTransport = (
  input: InfoHubRefreshInput,
  signal: AbortSignal,
) => Promise<unknown>;

/**
 * server function 的边界结果包着 `ok`，controller 只吃视图判别联合。
 * 失败（含 401/not_found）在这里收成一次失败刷新：controller 负责退避，
 * 页面保留最后一次成功事实，不把失败渲染成空集合。
 */
export async function unwrapRefreshResult(
  pending: Promise<InfoHubResult<InfoHubRefreshResult>>,
): Promise<InfoHubRefreshResult> {
  const result = await pending;
  if (!result.ok) throw new Error(`info_hub_refresh_failed:${result.error.code}`);
  return result.data;
}

const STATE_LABELS = {
  refreshing: "刷新中",
  current: "已是最新",
  hidden: "页面隐藏，已暂停",
  offline: "离线，已暂停",
  retrying: "刷新失败，退避重试中",
} as const;

type PollingState = keyof typeof STATE_LABELS;

export type InfoHubLive = {
  state: PollingState;
  /** 最近一次 `changed` 视图；这个页面还没刷新成功时为 null。 */
  view: InfoHubView | null;
  asOf: string | null;
};

const InfoHubLiveContext = createContext<InfoHubLive | null>(null);

/**
 * 页面的唯一 Info Hub 轮询者：一个可见页面一份 refresher，transport 是真实 server function。
 *
 * 只有这一层调用 `useInfoHubPolling`；组件不各自起请求，也不各自合并事实。
 * scope 变了（换 Chat、换视角）就换一个 refresher：旧请求被 controller 中断，
 * 结果按 scope 校验过才应用，A 的慢响应不会覆盖 B。
 */
export function InfoHubLiveProvider({
  projectId,
  query,
  refresh,
  children,
}: {
  projectId: string;
  query: InfoHubQuery;
  refresh: InfoHubRefreshTransport;
  children: ReactNode;
}) {
  const input = useMemo(
    () => ({ projectId, query }),
    // query 是每次渲染新建的对象；用它的事实做 key，避免每帧重启 refresher。
    [projectId, JSON.stringify(query)],
  );
  const scope = JSON.stringify(input);
  const [last, setLast] = useState<{
    scope: string;
    view: InfoHubView | null;
    asOf: string | null;
  }>({ scope, view: null, asOf: null });
  const state = useInfoHubPolling({
    input,
    refresh,
    onResult: (result) =>
      setLast({
        scope,
        view: result.kind === "changed" ? result.view : null,
        asOf: result.kind === "changed" ? result.view.asOf : result.asOf,
      }),
  });
  const value = useMemo<InfoHubLive>(
    () => ({
      state,
      // 换 scope 后上一 scope 的视图立刻作废，不让它渲染成新 scope 的事实。
      view: last.scope === scope ? last.view : null,
      asOf: last.scope === scope ? last.asOf : null,
    }),
    [state, scope, last],
  );
  return <InfoHubLiveContext.Provider value={value}>{children}</InfoHubLiveContext.Provider>;
}

/** 页面没挂 provider（或属于别的 scope）时返回 null，调用方退回 loader 事实。 */
export function useInfoHubLive(): InfoHubLive | null {
  return useContext(InfoHubLiveContext);
}

/** 刷新状态与事实时间：失败时保留最后成功事实，不显示成空集合。 */
export function InfoHubPollingStatus() {
  const live = useInfoHubLive();
  if (!live) return null;
  return (
    <p
      data-testid="info-hub-polling-state"
      data-state={live.state}
      data-as-of={live.asOf ?? ""}
      className="text-[10px] text-muted-foreground"
    >
      Info Hub {STATE_LABELS[live.state]}
      {live.asOf ? ` · 事实时间 ${live.asOf}` : ""}
    </p>
  );
}
