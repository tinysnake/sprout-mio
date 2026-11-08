import { Link } from "@tanstack/react-router";
import { Button } from "../ui/button";

export function SettingsTabs({
  projectId,
  tab,
}: {
  projectId: string;
  tab: "general" | "webhooks" | "cron";
}) {
  return (
    <nav
      aria-label="Project 设置分类"
      className="mb-6 flex flex-wrap gap-2 border-b border-border pb-4"
    >
      {(
        [
          { value: "general", label: "基础信息" },
          { value: "webhooks", label: "Webhooks" },
          { value: "cron", label: "定时任务" },
        ] as const
      ).map((item) => (
        <Button
          key={item.value}
          nativeButton={false}
          render={
            <Link
              to="/projects/$projectId/settings"
              params={{ projectId }}
              search={{ tab: item.value }}
              aria-current={tab === item.value ? "page" : undefined}
            />
          }
          variant={tab === item.value ? "secondary" : "ghost"}
          size="sm"
        >
          {item.label}
        </Button>
      ))}
    </nav>
  );
}
