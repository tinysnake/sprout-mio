import { useEffect, useRef } from "react";
import { cn } from "cn";
import type { SkillOption, ChatSkillChoices } from "../../contracts/skill";
import { mentionOptionId } from "./mention-picker";

export function SkillPicker({
  listId,
  matches,
  state,
  activeIndex,
  onPick,
  onActive,
}: {
  listId: string;
  matches: readonly SkillOption[];
  state: ChatSkillChoices["state"];
  activeIndex: number;
  onPick: (skill: SkillOption) => void;
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
      aria-label="可以调用的技能"
      data-testid="skill-picker"
      className="absolute bottom-full left-0 z-20 mb-1.5 max-h-56 w-full overflow-y-auto rounded-container border border-border bg-popover py-1 text-popover-foreground shadow-sm"
    >
      {matches.length === 0 ? (
        <p className="px-3 py-1.5 text-[11px] text-muted-foreground">
          {state === "disabled"
            ? "宿主技能继承已关闭"
            : state === "unavailable"
              ? "技能列表暂不可用"
              : "没有匹配的技能"}
        </p>
      ) : (
        matches.map((skill, index) => (
          <div
            key={skill.name}
            id={mentionOptionId(listId, index)}
            role="option"
            aria-selected={index === activeIndex}
            data-testid={`skill-option-${index}`}
            onMouseDown={(event) => {
              event.preventDefault();
              onPick(skill);
            }}
            onMouseMove={() => onActive(index)}
            className={cn(
              "cursor-default px-3 py-1.5 text-xs text-foreground",
              index === activeIndex && "bg-selected",
            )}
          >
            <div>{skill.name}</div>
            <div className="truncate text-[11px] text-muted-foreground">{skill.description}</div>
          </div>
        ))
      )}
    </div>
  );
}
