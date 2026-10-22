import { MoonIcon, SunIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useTheme } from "@/lib/theme";

/**
 * 自包含的主题切换按钮：主题状态来自 lib/theme 的单一来源，
 * 因此同一页面里的多个切换点始终显示同一个状态，也不需要调用方传 props。
 */
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
      onClick={toggle}
      className={className}
    >
      <Icon as={theme === "dark" ? SunIcon : MoonIcon} />
    </Button>
  );
}
