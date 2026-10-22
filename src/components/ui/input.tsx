import type { ComponentProps } from "react";
import { cn } from "cn";
import { useFieldControl } from "@/components/ui/field";

/**
 * 原生 input 的统一外观。控件本身仍是 `<input>`：原生表单取值、校验气泡和
 * 移动端键盘行为都保留，只把 38px 高、6px 圆角和语义色收进这一处。
 * 窄屏抬到 44px 触控高度，与 Button 的移动规格一致。
 */
export function Input({
  className,
  type = "text",
  id,
  "aria-invalid": ariaInvalid,
  "aria-describedby": ariaDescribedBy,
  ...props
}: ComponentProps<"input">) {
  const field = useFieldControl();
  return (
    <input
      type={type}
      data-slot="input"
      id={id ?? field?.controlId}
      aria-invalid={ariaInvalid ?? (field?.invalid || undefined)}
      aria-describedby={
        [ariaDescribedBy, field?.describedBy].filter(Boolean).join(" ") || undefined
      }
      className={cn(
        "min-h-9.5 w-full min-w-0 rounded-control border border-input bg-background px-2.75 py-2 text-[13px] text-foreground",
        "placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        "aria-invalid:border-destructive",
        "disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-65",
        "max-desktop:min-h-11",
        className,
      )}
      {...props}
    />
  );
}
