import { Link } from "@tanstack/react-router";
import { buttonVariants } from "../ui/button";

export function SettingsTabs({
  projectId,
  tab,
}: {
  projectId: string;
  tab: "general" | "webhooks" | "cron" | "feishu" | "memory";
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
          { value: "feishu", label: "飞书" },
          { value: "memory", label: "记忆" },
        ] as const
      ).map((item) => (
        <Link
          key={item.value}
          to="/projects/$projectId/settings"
          params={{ projectId }}
          search={{ tab: item.value }}
          aria-current={tab === item.value ? "page" : undefined}
          className={buttonVariants({
            variant: tab === item.value ? "secondary" : "ghost",
            size: "sm",
          })}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
