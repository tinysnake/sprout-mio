import type { ComponentProps } from "react";
import { cn } from "cn";
import { useFieldControl } from "@/components/ui/field";

/** 原生 textarea 的统一外观；行高按正文阅读密度，宽度由调用方布局决定。 */
export function Textarea({
  className,
  rows = 4,
  id,
  "aria-invalid": ariaInvalid,
  "aria-describedby": ariaDescribedBy,
  ...props
}: ComponentProps<"textarea">) {
  const field = useFieldControl();
  return (
    <textarea
      rows={rows}
      data-slot="textarea"
      id={id ?? field?.controlId}
      aria-invalid={ariaInvalid ?? (field?.invalid || undefined)}
      aria-describedby={
        [ariaDescribedBy, field?.describedBy].filter(Boolean).join(" ") || undefined
      }
      className={cn(
        "w-full min-w-0 rounded-control border border-input bg-background px-2.75 py-2 text-[13px] leading-7 text-foreground",
        "placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        "aria-invalid:border-destructive",
        "disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-65",
        className,
      )}
      {...props}
    />
  );
}
