import { createFileRoute } from "@tanstack/react-router";
import { devLoginEnabled, devLoginResponse } from "../server/dev-login";
import { getRequestContext } from "../server/request-context";

/**
 * 开发运行时的一次性登录入口：`/dev-login?to=/projects` 建好会话后 303 到目标页面。
 * HEAD 只报告可用性，不建会话，供人工预览工具挑选入口。
 */
export const Route = createFileRoute("/dev-login")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!(await devLoginEnabled())) return new Response("Not Found", { status: 404 });
        return devLoginResponse(request, getRequestContext(request).requestId);
      },
      HEAD: async () =>
        new Response(null, {
          status: (await devLoginEnabled()) ? 200 : 404,
          headers: { "cache-control": "no-store" },
        }),
    },
  },
});
