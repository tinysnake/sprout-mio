import { HeadContent, Link, Scripts, createRootRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { APP_VERSION } from "../contracts/version";
import { THEME_INIT_SCRIPT } from "../lib/theme";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      // 窄屏按真实设备宽度布局，并给输入区留出 safe-area 空间。
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { title: "Sprout Mio" },
      { name: "application-name", content: "sprout-mio" },
      { name: "application-version", content: APP_VERSION },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
    // 首屏样式前应用已保存的主题，避免浅色闪一下再变暗。
    scripts: [{ children: THEME_INIT_SCRIPT }],
  }),
  notFoundComponent: () => (
    <main className="mx-auto max-w-xl px-6 py-16">
      <h1 className="text-2xl font-semibold">页面不存在</h1>
      <Link to="/" className="mt-4 inline-block underline">
        返回首页
      </Link>
    </main>
  ),
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
