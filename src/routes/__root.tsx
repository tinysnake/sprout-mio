import { HeadContent, Link, Scripts, createRootRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { APP_VERSION } from "../contracts/version";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Sprout Mio" },
      { name: "application-name", content: "sprout-mio" },
      { name: "application-version", content: APP_VERSION },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
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
      <body className="min-h-screen font-sans antialiased">
        {children}
        <Scripts />
      </body>
    </html>
  );
}
