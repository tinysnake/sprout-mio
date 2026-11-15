import { ExternalLink } from "lucide-react";
import type { ChatSidePane } from "../chat/chat-search";
import { Icon } from "../ui/icon";
import { cn } from "cn";

/**
 * 右栏的两个页签共用一条头部：信息是 Chat 事实，文件是工作区。
 * 页签只是导航，不承载状态，切换写回 URL。
 */
export function SidePaneTabs({
  pane,
  onChange,
}: {
  pane: ChatSidePane;
  onChange: (pane: ChatSidePane) => void;
}) {
  return (
    <div role="tablist" aria-label="侧栏内容" className="flex items-center gap-1">
      {(
        [
          ["info", "信息"],
          ["files", "文件"],
        ] as const
      ).map(([value, label]) => (
        <button
          key={value}
          type="button"
          role="tab"
          aria-selected={pane === value}
          data-testid={`side-pane-tab-${value}`}
          onClick={() => onChange(value)}
          className={cn(
            "rounded-[var(--control-radius)] px-2 py-1 text-[12px] text-muted-foreground hover:bg-hover hover:text-foreground",
            pane === value && "bg-selected font-medium text-foreground",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** 文件行上的「新标签页打开」：一步到位，不必先预览再找按钮。 */
export function NewTabLink({ href, name }: { href: string; name: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label={`在新标签页打开 ${name}`}
      title="在新标签页打开"
      data-testid="workspace-open-new-tab"
      onClick={(event) => event.stopPropagation()}
      className="ml-auto inline-flex size-5 shrink-0 items-center justify-center rounded-[var(--control-radius)] text-muted-foreground opacity-0 hover:bg-selected hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
    >
      <Icon as={ExternalLink} size={13} />
    </a>
  );
}
