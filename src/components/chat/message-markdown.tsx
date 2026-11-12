import {
  cloneElement,
  createElement,
  Fragment,
  isValidElement,
  useMemo,
  type ElementType,
  type ReactNode,
} from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { MentionSpan } from "../../contracts/chat";
import type { MessageSkillSpan } from "../../contracts/skill";
import {
  maskMessageSegments,
  sentinelPattern,
  type MessageSegment,
  type MessageSentinel,
} from "./message-segments";
import { SkillMark } from "./skill-mark";

/**
 * 消息正文的 markdown 渲染。
 *
 * 只渲染 markdown 子集：加粗、斜体、行内代码、围栏代码、无序与有序列表、标题、引用块与链接
 * （裸 URL 由 remark-gfm 的 autolink 认出来）。原文里的 HTML 标签不经 rehype-raw，只会当字面文本出现。
 * 点名与技能 pill 的冻结区间先占位成哨兵，解析后再回填成既有组件，字符范围一字不改。
 */
export function MessageMarkdown({
  body,
  mentions,
  skills,
}: {
  body: string;
  mentions: readonly MentionSpan[];
  skills: readonly MessageSkillSpan[];
}) {
  const { text, sentinels } = useMemo(
    () => maskMessageSegments(body, mentions, skills),
    [body, mentions, skills],
  );
  const components = useMemo(() => componentsWithSentinels(sentinels), [sentinels]);
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={components}>
      {text}
    </Markdown>
  );
}

/** 可能装正文的标签：容器标签统一走同一个回填函数，叶子里的哨兵就地换成点名或技能 pill。 */
const TEXT_TAGS = [
  "p",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "strong",
  "em",
  "code",
  "a",
  "td",
  "th",
] as const;

type SentinelProps = { children?: ReactNode; node?: unknown } & Record<string, unknown>;

function componentsWithSentinels(sentinels: readonly MessageSentinel[]): Components {
  const fill = (children: ReactNode): ReactNode => fillSentinels(children, sentinels);
  const components: Record<string, (props: SentinelProps) => ReactNode> = {};
  for (const tag of TEXT_TAGS) {
    // react-markdown 会额外传 node；它不是 DOM 属性，不能落到元素上。
    components[tag] = ({ children, node: _node, ...rest }) =>
      createElement(tag as ElementType, rest, fill(children));
  }
  return components as unknown as Components;
}

function fillSentinels(node: ReactNode, sentinels: readonly MessageSentinel[]): ReactNode {
  if (typeof node === "string") return splitSentinels(node, sentinels);
  if (Array.isArray(node)) {
    return node.map((child, index) => (
      <Fragment key={index}>{fillSentinels(child as ReactNode, sentinels)}</Fragment>
    ));
  }
  if (isValidElement<{ children?: ReactNode }>(node) && node.props.children !== undefined) {
    return cloneElement(node, { children: fillSentinels(node.props.children, sentinels) });
  }
  return node;
}

/** 哨兵只可能来自本组件的占位；下标对不上时按原文保留，绝不吞字。 */
function splitSentinels(text: string, sentinels: readonly MessageSentinel[]): ReactNode {
  const pattern = sentinelPattern();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null = pattern.exec(text);
  while (match !== null) {
    const sentinel = sentinels[Number(match[1])];
    if (sentinel) {
      if (match.index > cursor) parts.push(text.slice(cursor, match.index));
      parts.push(<SentinelMark key={parts.length} segment={sentinel.segment} />);
      cursor = match.index + match[0].length;
    }
    match = pattern.exec(text);
  }
  if (parts.length === 0) return text;
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

/** 回填成与切片路径完全相同的标记：测试钩子、类名与文本都不变。 */
function SentinelMark({ segment }: { segment: MessageSegment }) {
  if (segment.skill) {
    return (
      <SkillMark
        data-testid="message-skill"
        name={segment.skill.name}
        text={segment.text}
        edge={segment.skillEdge}
      />
    );
  }
  if (segment.span) {
    return (
      <span
        data-testid="message-mention"
        data-member-kind={segment.span.memberKind}
        data-member-id={segment.span.memberId}
        className="rounded-[3px] bg-selected px-1 font-medium [box-decoration-break:clone]"
      >
        {segment.text}
      </span>
    );
  }
  return <>{segment.text}</>;
}
