import type { ReactNode } from "react";
import { Link, type LinkProps } from "@tanstack/react-router";

/**
 * 页面返回入口的唯一形状：左箭头、12px 标签、44px 触控行。
 * 链接与历史按钮共用同一份样式，避免详情页和列表页各写一套字号。
 */
const pageBackClass =
  "inline-flex min-h-11 items-center gap-2 text-xs leading-normal text-foreground underline-offset-4 transition-colors hover:text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export function PageBackLink(props: Omit<LinkProps, "className">) {
  return <Link {...props} className={pageBackClass} />;
}

export function PageBackButton({
  children,
  onClick,
  testId,
}: {
  children: ReactNode;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button type="button" data-testid={testId} className={pageBackClass} onClick={onClick}>
      {children}
    </button>
  );
}
