import { BookOpen } from "lucide-react";
import type { ComponentProps } from "react";
import { SKILL_MARK } from "../../lib/skill-token";
import { Icon } from "../ui/icon";
import "./skill-mark.css";

/**
 * 技能标记，消息正文与输入框镜像共用。
 *
 * 输入框的镜像层必须与 textarea 等宽，所以 `📖` 以不透明度 0 留在文本流里撑出宽度
 * （选中与复制仍然带标记），图标绝对定位压在同一位置，不参与布局。旧格式
 * `【技能:<name>】` 没有这个字形，按原文渲染。
 */
export function SkillMark({
  name,
  text,
  ...props
}: { name: string; text: string } & ComponentProps<"span">) {
  if (!text.startsWith(SKILL_MARK)) return <>{text}</>;

  return (
    <span className="skill-mark" data-skill-name={name} {...props}>
      <span className="skill-mark-glyph">{SKILL_MARK}</span>
      <Icon as={BookOpen} className="skill-mark-icon" />
      {text.slice(SKILL_MARK.length)}
    </span>
  );
}
