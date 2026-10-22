import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import { LoaderCircleIcon } from "lucide-react";
import { Icon } from "@/components/ui/icon";

/*
 * 常规控件 34px 高、6px 圆角、12px 字号，数值来自设计基线的实测值；
 * 窄屏统一抬到 44px 触控高度，而不是给每个页面各写一份。
 * primary 使用加深后的 --primary：橙原色配白字达不到 AA。
 */
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.75 rounded-control border border-transparent bg-clip-padding text-xs font-medium whitespace-nowrap transition-[background-color,border-color,color] duration-150 outline-none select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-45 data-disabled:pointer-events-none data-disabled:opacity-45 active:not-disabled:not-data-disabled:translate-y-px [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        /** 主操作：唯一使用橙色填充的按钮。 */
        default: "bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/82",
        /** 有边框的中性操作：返回、取消、次要提交。 */
        secondary:
          "border-border bg-background text-foreground hover:border-foreground active:bg-background",
        /** 无边框的图标与行内操作；展开或按下时用 selected 表面。 */
        ghost:
          "bg-transparent text-foreground hover:border-input aria-expanded:border-border aria-expanded:bg-selected",
        /** 破坏性操作同时着色文字与边框，不只靠颜色区分。 */
        destructive: "border-destructive bg-destructive-soft text-destructive hover:bg-background",
        /** 正文中的链接式动作：用下划线而不是橙色文字表达可点。 */
        link: "text-foreground underline decoration-input underline-offset-3 hover:decoration-foreground",
        /** `outline` 是迁移前的中性有边框按钮名，与本轮的 secondary 同一外观。 */
        outline:
          "border-border bg-background text-foreground hover:border-foreground active:bg-background",
      },
      size: {
        default: "min-h-8.5 px-2.75 py-1.5",
        xs: "min-h-6 px-2 text-[0.6875rem]",
        sm: "min-h-7 px-2 text-[0.6875rem]",
        lg: "min-h-10 px-3 text-sm",
        icon: "size-8.5 p-0",
        "icon-xs": "size-6 p-0",
        "icon-sm": "size-7 p-0",
        "icon-lg": "size-10 p-0",
      },
    },
    compoundVariants: [
      { variant: "link", size: ["default", "xs", "sm", "lg"], class: "min-h-0 p-0" },
      {
        variant: ["default", "secondary", "ghost", "destructive", "outline"],
        class: "max-desktop:min-h-11",
      },
      { size: ["icon", "icon-xs", "icon-sm", "icon-lg"], class: "max-desktop:size-11" },
    ],
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

type ButtonProps = ButtonPrimitive.Props &
  VariantProps<typeof buttonVariants> & {
    /**
     * 提交中的呈现。置为 true 时按钮同时不可点击，避免重复提交；
     * 视觉上换成旋转图标并保留原宽度，不让布局跳动。
     */
    loading?: boolean;
  };

function Button({
  className,
  variant = "default",
  size = "default",
  loading = false,
  disabled,
  children,
  ...props
}: ButtonProps) {
  return (
    <ButtonPrimitive
      data-slot="button"
      data-loading={loading || undefined}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    >
      {loading && <Icon as={LoaderCircleIcon} className="animate-spin" />}
      {children}
    </ButtonPrimitive>
  );
}

export { Button, buttonVariants };
