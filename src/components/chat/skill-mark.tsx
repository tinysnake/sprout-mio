import { BookOpen } from "lucide-react";
import type { ComponentProps } from "react";
import { SKILL_MARK } from "../../lib/skill-token";
import { Icon } from "../ui/icon";
import type { SkillEdge } from "./message-segments";
import "./skill-mark.css";

/**
 * 技能标记，消息正文与输入框镜像共用。
 *
 * `📖` 留在文本流里撑出宽度，图标绝对定位压在同一槽位，所以镜像层的前进宽度与 textarea 相同。
 */
export function SkillMark({
  name,
  text,
  edge,
  ...props
}: {
  name: string;
  text: string;
  edge?: { start: SkillEdge; end: SkillEdge };
} & ComponentProps<"span">) {
  if (!text.startsWith(SKILL_MARK)) return <>{text}</>;

  return (
    <span
      className="skill-mark"
      data-skill-name={name}
      data-edge-start={edge && edge.start !== "full" ? edge.start : undefined}
      data-edge-end={edge && edge.end !== "full" ? edge.end : undefined}
      {...props}
    >
      <span className="skill-mark-glyph" aria-hidden="true">
        <span className="skill-mark-raw">{SKILL_MARK}</span>
        <Icon as={BookOpen} className="skill-mark-icon" />
      </span>
      {text.slice(SKILL_MARK.length)}
    </span>
  );
}
