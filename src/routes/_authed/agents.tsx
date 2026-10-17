import { Outlet, createFileRoute } from "@tanstack/react-router";

/** Agent 的公共外壳，全局列表与 profile 详情各自是它的子路由。 */
export const Route = createFileRoute("/_authed/agents")({
  component: () => <Outlet />,
});
