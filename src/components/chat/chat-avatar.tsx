import { cn } from "cn";

/**
 * Chat 场景共用的头像：Agent 用 8px 圆角方块，Human 用品牌橙圆形，
 * 与设计基线一致。没有头像资源，因此用名称首字，不引入图片依赖。
 */
export function ChatAvatar({
  name,
  human = false,
  small = false,
  className,
}: {
  name: string;
  human?: boolean;
  small?: boolean;
  className?: string;
}) {
  const label = name.trim().slice(0, 1);
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-lg border border-border bg-secondary text-xs font-medium text-foreground",
        small ? "size-6 rounded-control text-[10px]" : "size-7.5",
        human && "rounded-full border-primary bg-primary text-primary-foreground",
        className,
      )}
    >
      {label}
    </span>
  );
}
