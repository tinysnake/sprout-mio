import { useRouter } from "@tanstack/react-router";
import type { AnchorHTMLAttributes, ReactNode } from "react";

type Props = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  href: string;
  children: ReactNode;
};

/**
 * 站内链接。渲染成真正的 `a[href]`，有路由时接管点击走客户端跳转。
 *
 * 直接写 `a[href]` 会让整页重新加载：服务端重跑一遍、客户端重新挂载、滚动位置和
 * 已输入的草稿一起丢掉。做成组件而不是到处用 `Link`，是因为部分组件要在没有
 * RouterProvider 的静态渲染里工作，那里必须留下可点的 `href`。
 */
export function AppLink({ href, children, onClick, ...rest }: Props) {
  const router = useRouter({ warn: false });

  return (
    <a
      {...rest}
      href={href}
      onClick={(event) => {
        onClick?.(event);
        const modified =
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey;
        if (!router || modified) return;
        event.preventDefault();
        void router.navigate({ href });
      }}
    >
      {children}
    </a>
  );
}
