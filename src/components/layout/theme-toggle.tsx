import { MoonIcon, PaletteIcon, SunIcon, SunMoonIcon } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useTheme, type ThemePreference } from "@/lib/theme";

/** 外观的三个选项；数组顺序就是界面上从左到右的顺序。 */
const THEME_CHOICES: { value: ThemePreference; label: string; icon: LucideIcon }[] = [
  { value: "system", label: "跟随系统", icon: SunMoonIcon },
  { value: "light", label: "浅色", icon: SunIcon },
  { value: "dark", label: "深色", icon: MoonIcon },
];

/**
 * 账号菜单里的外观入口：「调色板 + 外观」是标签，右侧三格是连在一起的互斥选项。
 * 三格与外层同属一个常显边框的控件，避免三个图标被当成三个独立按钮；
 * 标签那一段不用可点击样式、不做 hover，避免看起来也能点。
 * 行的内边距与图标间距取账号菜单里按钮的同一套数值，两行的图标与文字左右对齐。
 */
export function ThemeMenuToggle() {
  const { preference, setPreference } = useTheme();

  return (
    <div
      role="radiogroup"
      aria-label="外观"
      className="flex min-h-8.5 w-full items-center gap-1.75 rounded-control border border-transparent px-2.75 py-1.5 max-desktop:min-h-11"
    >
      <span className="flex flex-none items-center gap-1.75 text-xs font-medium text-muted-foreground">
        <Icon as={PaletteIcon} />
        外观
      </span>
      <div className="flex min-w-0 flex-1 overflow-hidden rounded-control border border-border bg-background">
        {THEME_CHOICES.map((choice, index) => {
          const selected = preference === choice.value;
          return (
            <label
              key={choice.value}
              title={choice.label}
              data-testid={`theme-option-${choice.value}`}
              data-checked={selected ? "true" : "false"}
              className={cn(
                "flex h-8 min-w-0 flex-1 cursor-pointer items-center justify-center text-foreground transition-colors duration-150 hover:bg-hover has-[:focus-visible]:outline-2 has-[:focus-visible]:-outline-offset-2 has-[:focus-visible]:outline-ring",
                index > 0 && "border-l border-border",
                selected && "bg-selected",
              )}
            >
              <input
                type="radio"
                name="sprout-theme"
                value={choice.value}
                checked={selected}
                onChange={() => setPreference(choice.value)}
                className="sr-only"
              />
              <Icon as={choice.icon} />
              <span className="sr-only">{choice.label}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

/** 还没有账号菜单的登录页用它。进入应用后外观入口统一在账号菜单里。 */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, toggle } = useTheme();
  const label = theme === "dark" ? "切换浅色主题" : "切换暗色主题";

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      data-testid="theme-toggle"
      data-theme={theme}
      onClick={toggle}
      className={className}
    >
      <Icon as={theme === "dark" ? SunIcon : MoonIcon} />
    </Button>
  );
}
