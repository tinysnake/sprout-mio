import type { ComponentProps } from "react";
import { cn } from "cn";
import { useFieldControl } from "@/components/ui/field";

/**
 * 原生 select 的统一外观。选项列表交给操作系统渲染，因此不换成自定义弹层：
 * 模型、effort 这类字段的候选项可能为空，原生控件在缺失和禁用时行为最可预期。
 */
export function Select({
  className,
  id,
  "aria-invalid": ariaInvalid,
  "aria-describedby": ariaDescribedBy,
  ...props
}: ComponentProps<"select">) {
  const field = useFieldControl();
  return (
    <select
      data-slot="select"
      id={id ?? field?.controlId}
      aria-invalid={ariaInvalid ?? (field?.invalid || undefined)}
      aria-describedby={
        [ariaDescribedBy, field?.describedBy].filter(Boolean).join(" ") || undefined
      }
      className={cn(
        "min-h-9.5 w-full min-w-0 rounded-control border border-input bg-background px-2.75 py-2 text-[13px] text-foreground",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        "aria-invalid:border-destructive",
        "disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-65",
        "max-desktop:min-h-11",
        className,
      )}
      {...props}
    />
  );
}
