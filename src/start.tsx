import { createMiddleware, createStart } from "@tanstack/react-start";
import { APP_VERSION } from "./contracts/version";

const httpBoundary = createMiddleware().server(async ({ request, handlerType, next }) => {
  const pathname = new URL(request.url).pathname;
  if (pathname === "/api/ping") {
    return Response.json({
      app: "sprout-mio",
      version: APP_VERSION,
      probe: "http",
      runtime: "unimplemented",
    });
  }
  const result = await next();
  if (
    handlerType === "router" &&
    request.method === "GET" &&
    pathname !== "/api" &&
    !pathname.startsWith("/api/") &&
    result.response.status === 404 &&
    result.response.headers.get("content-type")?.includes("text/html")
  ) {
    return new Response(result.response.body, { status: 200, headers: result.response.headers });
  }
  return result;
});

// 构建期 shell 配置不能关闭运行期 SSR，两个入口必须同时设置。
export const startInstance = createStart(() => ({
  defaultSsr: false,
  requestMiddleware: [httpBoundary],
}));
