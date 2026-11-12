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
import type { Attachment } from "../../contracts/attachment";
import type { MentionSpan, MessageAttachmentSpan } from "../../contracts/chat";
import type { MessageSkillSpan } from "../../contracts/skill";
import {
  AttachmentMissingRef,
  AttachmentRefChip,
  MessageAttachments,
  partitionAttachments,
} from "./message-attachments";
import { maskMessageSegments, type MessageSegment, type MessageSentinel } from "./message-segments";
import { SkillMark } from "./skill-mark";
import "./message-markdown.css";

/**
 * 消息正文的 markdown 渲染。
 *
 * 允许的构造：加粗、斜体、行内代码、围栏代码、无序与有序列表、标题、引用块、链接（含 remark-gfm
 * 认出的裸 URL），以及 gfm 顺带带来的表格与删除线。原文里的 HTML 标签不经 rehype-raw，只当字面文本。
 *
 * 两处刻意的降级：
 * - markdown 源里的图片不渲染。正文可以来自模型与外部输入，渲染它等于让任何一条消息都能让读者的浏览器
 *   去请求任意外部地址，react-markdown 还会顺带带出一条 preload link。附件图片不走这条路：它有自己的
 *   鉴权读取路由（`/api/attachments/<id>`），字节只在同一个 Project 的会话里可取。
 * - 站外链接补 rel 并另开标签页，不把应用页导航走。
 *
 * 点名、技能与附件引用的冻结区间先占位成带 nonce 的哨兵，解析后再回填成既有组件，字符范围一字不改。
 */
export function MessageMarkdown({
  body,
  mentions,
  skills,
  attachments = [],
  attachmentSpans = [],
}: {
  body: string;
  mentions: readonly MentionSpan[];
  skills: readonly MessageSkillSpan[];
  attachments?: readonly Attachment[];
  attachmentSpans?: readonly MessageAttachmentSpan[];
}) {
  const { text, sentinels } = useMemo(
    () => maskMessageSegments(body, mentions, skills, attachmentSpans),
    [body, mentions, skills, attachmentSpans],
  );
  const attachmentsById = useMemo(
    () => new Map(attachments.map((attachment) => [attachment.id, attachment])),
    [attachments],
  );
  const components = useMemo(
    () => componentsWithSentinels(sentinels, attachmentsById),
    [sentinels, attachmentsById],
  );
  const { figures, chips } = useMemo(
    () => partitionAttachments(attachments, attachmentSpans),
    [attachments, attachmentSpans],
  );
  return (
    <div className="message-markdown">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </Markdown>
      <MessageAttachments figures={figures} chips={chips} />
    </div>
  );
}

/** 可能装正文的标签：统一走同一个回填函数，叶子里的哨兵就地换成点名或技能 pill。 */
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
  "td",
  "th",
] as const;

type SentinelProps = { children?: ReactNode; node?: unknown } & Record<string, unknown>;

function componentsWithSentinels(
  sentinels: readonly MessageSentinel[],
  attachmentsById: ReadonlyMap<string, Attachment>,
): Components {
  const fill = (children: ReactNode): ReactNode =>
    fillSentinels(children, sentinels, attachmentsById);
  const components: Record<string, (props: SentinelProps) => ReactNode> = {};
  for (const tag of TEXT_TAGS) {
    // react-markdown 会额外传 node；它不是 DOM 属性，不能落到元素上。
    components[tag] = ({ children, node: _node, ...rest }) =>
      createElement(tag as ElementType, rest, fill(children));
  }
  components.a = ({ children, node: _node, href, ...rest }) =>
    createElement("a", { ...rest, href, ...externalLinkAttributes(href) }, fill(children));
  components.img = ({ node: _node, src, alt }) => createElement("span", null, imageText(src, alt));
  return components as unknown as Components;
}

/** 站外链接不继承应用页的 referrer，也不把用户从 Chat 里导航走。 */
function externalLinkAttributes(href: unknown): { rel?: string; target?: string } {
  return typeof href === "string" && /^https?:/iu.test(href)
    ? { rel: "noreferrer", target: "_blank" }
    : {};
}

/** RM1 的图片降级：只留可读文字，绝不发出请求；字节与鉴权在 RM2。 */
function imageText(src: unknown, alt: unknown): string {
  if (typeof alt === "string" && alt.length > 0) return alt;
  return typeof src === "string" ? src : "";
}

function fillSentinels(
  node: ReactNode,
  sentinels: readonly MessageSentinel[],
  attachmentsById: ReadonlyMap<string, Attachment>,
): ReactNode {
  if (typeof node === "string") return splitSentinels(node, sentinels, attachmentsById);
  if (Array.isArray(node)) {
    return node.map((child, index) => (
      <Fragment key={index}>{fillSentinels(child as ReactNode, sentinels, attachmentsById)}</Fragment>
    ));
  }
  if (isValidElement<{ children?: ReactNode }>(node) && node.props.children !== undefined) {
    return cloneElement(node, {
      children: fillSentinels(node.props.children, sentinels, attachmentsById),
    });
  }
  return node;
}

/**
 * 按每个哨兵的完整 token 切分，不做共享正则匹配：token 带一次性 nonce，正文自身不可能与它同形。
 * 某个 token 在该文本里没出现时原样留下，绝不吞字。
 */
function splitSentinels(
  text: string,
  sentinels: readonly MessageSentinel[],
  attachmentsById: ReadonlyMap<string, Attachment>,
): ReactNode {
  let parts: ReactNode[] = [text];
  let key = 0;
  for (const sentinel of sentinels) {
    const next: ReactNode[] = [];
    for (const part of parts) {
      if (typeof part !== "string") {
        next.push(part);
        continue;
      }
      const pieces = part.split(sentinel.token);
      if (pieces.length === 1) {
        next.push(part);
        continue;
      }
      pieces.forEach((piece, index) => {
        if (index > 0)
          next.push(
            <SentinelMark
              key={"sentinel-" + key++}
              segment={sentinel.segment}
              attachmentsById={attachmentsById}
            />,
          );
        if (piece.length > 0) next.push(piece);
      });
    }
    parts = next;
  }
  return parts.length === 1 && typeof parts[0] === "string" ? text : parts;
}

/** 回填成与切片路径完全相同的标记：测试钩子、类名与文本都不变。 */
function SentinelMark({
  segment,
  attachmentsById,
}: {
  segment: MessageSegment;
  attachmentsById: ReadonlyMap<string, Attachment>;
}) {
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
  if (segment.attachment) {
    const attachment = attachmentsById.get(segment.attachment.attachmentId);
    return attachment ? (
      <AttachmentRefChip attachment={attachment} />
    ) : (
      <AttachmentMissingRef attachmentId={segment.attachment.attachmentId} />
    );
  }
  return <>{segment.text}</>;
}
