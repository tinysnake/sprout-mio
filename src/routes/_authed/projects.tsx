import { Outlet, createFileRoute } from "@tanstack/react-router";

/** Project 的公共外壳，列表与详情各自是它的子路由。 */
export const Route = createFileRoute("/_authed/projects")({
  component: () => <Outlet />,
});
