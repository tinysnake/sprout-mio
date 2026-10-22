import type { ComponentProps } from "react";
import type { LucideIcon } from "lucide-react";

type IconProps = Omit<ComponentProps<LucideIcon>, "size" | "strokeWidth"> & {
  as: LucideIcon;
  /** 常规图标 16px；只有与更大字号或更大的控件同排时才调大。 */
  size?: number;
};

/**
 * 全站唯一的图标入口。图标家族、默认尺寸和描边宽度收在这里，
 * 页面只需要说明用哪一个，不各自传 size / strokeWidth。
 * 默认 `aria-hidden`：图标旁边必须另有文字或 aria-label 才可辨识。
 */
export function Icon({ as: Glyph, size = 16, ...props }: IconProps) {
  return <Glyph size={size} strokeWidth={1.5} aria-hidden="true" {...props} />;
}
