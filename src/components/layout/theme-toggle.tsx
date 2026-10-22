import { MoonIcon, SunIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useTheme } from "@/lib/theme";

/**
 * 账号菜单里的主题入口：一行按钮，点击在浅暗之间切换。
 * 文案描述「点下去会发生什么」，当前生效的主题由图标与下一段文字表达。
 */
export function ThemeMenuToggle({ onSelected }: { onSelected?: () => void }) {
  const { theme, toggle } = useTheme();
  const toDark = theme !== "dark";
  const label = toDark ? "切换到暗色主题" : "切换到浅色主题";

  return (
    <Button
      type="button"
      variant="ghost"
      aria-label={label}
      title={label}
      data-testid="theme-toggle"
      data-theme={theme}
      onClick={() => {
        toggle();
        onSelected?.();
      }}
      className="w-full justify-start"
    >
      <Icon as={toDark ? MoonIcon : SunIcon} />
      {toDark ? "切换到暗色" : "切换到浅色"}
    </Button>
  );
}

/** 还没有账号菜单的登录页用它。进入应用后主题入口统一在账号菜单里。 */
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
