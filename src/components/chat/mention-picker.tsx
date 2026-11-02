import { useEffect, useRef } from "react";
import { cn } from "cn";

/** 输入框可 @ 的成员：id 只用于区分候选项，正文里插入的只有名字。 */
export type MentionMember = { memberId: string; name: string };

/** 光标前一段还没选定的 `@查询`：`start` 指向 `@`，`end` 等于光标。 */
export type MentionQuery = { start: number; end: number; query: string };

/** 查询词最长回看距离，避免在大段正文里一路扫描到文件开头。 */
const QUERY_LOOKBEHIND = 32;

function isSeparator(char: string): boolean {
  return char === "" || /\s/.test(char);
}

/**
 * `@` 必须在开头或空白之后，查询词里不能有空白：这样邮箱这类正文里的普通 `@`
 * 不会打开浮层。光标在词中间时按光标位置判定，不整段重算。
 */
export function mentionQueryAt(value: string, caret: number): MentionQuery | null {
  if (caret <= 0 || caret > value.length) return null;
  const from = Math.max(0, caret - QUERY_LOOKBEHIND);
  for (let index = caret - 1; index >= from; index -= 1) {
    const char = value[index]!;
    if (/\s/.test(char)) return null;
    if (char !== "@") continue;
    if (!isSeparator(index === 0 ? "" : value[index - 1]!)) return null;
    return { start: index, end: caret, query: value.slice(index + 1, caret) };
  }
  return null;
}

/** 按名字过滤；同名成员只留第一条，插入结果里出现两个同一个名字没有意义。 */
export function matchMembers(members: readonly MentionMember[], query: string): MentionMember[] {
  const needle = query.trim().toLowerCase();
  const seen = new Set<string>();
  const matched: MentionMember[] = [];
  for (const member of members) {
    const name = member.name.trim();
    if (!name || seen.has(name)) continue;
    if (needle && !name.toLowerCase().includes(needle)) continue;
    seen.add(name);
    matched.push({ memberId: member.memberId, name });
  }
  return matched;
}

/** 只把 `@名字 ` 插到选中范围上，替掉用户输入的查询词，光标落在空格之后。 */
export function insertMention(
  value: string,
  at: MentionQuery,
  name: string,
): { value: string; caret: number } {
  const insert = `@${name} `;
  return {
    value: value.slice(0, at.start) + insert + value.slice(at.end),
    caret: at.start + insert.length,
  };
}

export function mentionOptionId(listId: string, index: number): string {
  return `${listId}-option-${index}`;
}

/**
 * 成员选择浮层：挂在输入框容器顶边，不跟随光标。键盘移动与选中由 textarea 的
 * `aria-activedescendant` 驱动，浮层自己只负责呈现与把选中的一行滚进视口。
 */
export function MentionPicker({
  listId,
  label,
  matches,
  activeIndex,
  onPick,
  onActive,
}: {
  listId: string;
  label: string;
  matches: readonly MentionMember[];
  activeIndex: number;
  onPick: (member: MentionMember) => void;
  onActive: (index: number) => void;
}) {
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const option = list.current?.children[activeIndex];
    if (option instanceof HTMLElement) option.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
    <div
      ref={list}
      id={listId}
      role="listbox"
      aria-label={label}
      data-testid="mention-picker"
      className="absolute bottom-full left-0 z-20 mb-1.5 max-h-56 w-full overflow-y-auto rounded-container border border-border bg-popover py-1 text-popover-foreground shadow-sm"
    >
      {matches.length === 0 ? (
        <p className="px-3 py-1.5 text-[11px] text-muted-foreground">没有匹配的成员</p>
      ) : (
        matches.map((member, index) => (
          <div
            key={member.memberId}
            id={mentionOptionId(listId, index)}
            role="option"
            aria-selected={index === activeIndex}
            data-testid={`mention-option-${index}`}
            data-member-name={member.name}
            // mousedown 就选中：等 click 时 textarea 已经 blur，浮层先收起来了。
            onMouseDown={(event) => {
              event.preventDefault();
              onPick(member);
            }}
            onMouseMove={() => onActive(index)}
            className={cn(
              "cursor-default truncate px-3 py-1.5 text-xs text-foreground",
              index === activeIndex && "bg-selected",
            )}
          >
            {member.name}
          </div>
        ))
      )}
    </div>
  );
}
