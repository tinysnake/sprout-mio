import { useEffect, useMemo, useRef } from "react";
import { AtSign, BookOpen, Paperclip } from "lucide-react";
import { Extension, type Editor } from "@tiptap/core";
import {
  EditorContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditor,
  type NodeViewProps,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import type { ResolvedPos } from "@tiptap/pm/model";
import { newlineInCode, splitBlockKeepMarks } from "@tiptap/pm/commands";
import type { Transaction } from "@tiptap/pm/state";
import { attachmentToken } from "../../contracts/attachment";
import { skillToken } from "../../lib/skill-token";
import { Icon } from "../ui/icon";
import {
  COMPOSER_UNDO_GROUP_DELAY,
  groupUndoByChangeKind,
  type ComposerChangeKind,
} from "./tiptap/composer-undo-grouping";
import {
  ComposerMarkdownSourceExtension,
  collapseShownMarkdownSource,
} from "./tiptap/composer-markdown-source";
import {
  exitCodeBlockOnClosingFence,
  exitCodeBlockOnTrailingBlankLines,
  convertCodeFenceOnEnter,
  indentCodeBlock,
  indentedNewlineInCodeBlock,
  selectionInOneCodeBlock,
} from "./tiptap/composer-code-block";
import {
  COMPOSER_ATTACHMENT_NODE,
  COMPOSER_MENTION_NODE,
  COMPOSER_SKILL_NODE,
  ComposerAttachmentExtension,
  ComposerMentionExtension,
  ComposerSkillExtension,
} from "./tiptap/composer-rich-text-nodes";
import type { MentionCandidate } from "./tiptap/composer-prompt-segments";
import {
  blockquoteInputRule,
  bulletToTaskInputRule,
  headingInputRule,
  horizontalRuleInputRule,
  listMarkerInputRule,
  taskInputRule,
} from "./tiptap/composer-block-shortcuts";
import {
  ComposerBlockExtensions,
  ComposerBoldExtension,
  ComposerCodeBlockExtension,
  ComposerCodeExtension,
  ComposerItalicExtension,
  ComposerListExtensions,
  ComposerStrikeExtension,
  ComposerTaskItemExtension,
  ComposerTaskListExtension,
  buildDocJson,
  flatToPm,
  flatToMarkdown,
  markdownToFlat,
  pmToFlat,
  serializeEditorDoc,
  splitOrLiftListItem,
} from "./tiptap/composer-rich-text-doc";
import "./markdown-content.css";

/** 光标所在链路上有没有这种祖先节点，逐层看而不是只看当前块。 */
function hasAncestor($pos: ResolvedPos, name: string): boolean {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if ($pos.node(depth).type.name === name) return true;
  }
  return false;
}

/** 输入区对外只需要「聚焦」与「按 markdown 偏移插入」两类动作。 */
export interface ComposerEditorHandle {
  focus(): void;
  /** 当前正文的 markdown（发送时读这里，比 React 状态少一帧延迟）。 */
  markdown(): string;
  /** 在 markdown 区间上插入一条附件引用芯片。 */
  insertAttachment(from: number, to: number, localId: string, label: string): void;
  /** 在 markdown 区间上插入一个点名芯片，尾部补一个空格。 */
  insertMention(from: number, to: number, member: MentionCandidate): void;
  /** 在 markdown 区间上插入一个技能芯片，尾部补一个空格。 */
  insertSkill(from: number, to: number, name: string): void;
  /** 删掉正文里指向该附件的全部芯片，返回是否删到了东西。 */
  removeAttachment(localId: string): boolean;
}

/** 撤销分组：在 history 插件应用事务之前决定这次改动与上次是否相邻。 */
const ComposerUndoGroupingExtension = Extension.create<
  Record<string, never>,
  { previous: ComposerChangeKind | null }
>({
  name: "composer-undo-grouping",
  addStorage() {
    return { previous: null };
  },
  dispatchTransaction({ transaction, next }) {
    this.storage.previous = groupUndoByChangeKind(transaction, this.storage.previous);
    next(transaction);
  },
});

const CHIP_ICONS = {
  attachment: Paperclip,
  skill: BookOpen,
  mention: AtSign,
} as const;

type ChipKind = keyof typeof CHIP_ICONS;

function ComposerChip({
  kind,
  label,
  localId,
}: {
  kind: ChipKind;
  label: string;
  /** 附件芯片带上自己的 localId，验收与调试靠它把芯片和附件栏对上。 */
  localId?: string;
}) {
  return (
    <NodeViewWrapper
      as="span"
      className="markdown-chip"
      data-testid="composer-chip"
      data-chip-kind={kind}
      data-local-id={localId}
      contentEditable={false}
    >
      <Icon as={CHIP_ICONS[kind]} size={13} className="markdown-chip__icon" />
      <span className="markdown-chip__name">{label}</span>
    </NodeViewWrapper>
  );
}

function AttachmentChipView({ node }: NodeViewProps, labelFor: (localId: string) => string) {
  const localId = typeof node.attrs.localId === "string" ? node.attrs.localId : "";
  const inserted = typeof node.attrs.label === "string" ? node.attrs.label : "";
  // 插入时记下的名字优先，恢复旧草稿时再向父层要；都拿不到就显示「附件」。
  return (
    <ComposerChip
      kind="attachment"
      localId={localId || undefined}
      label={inserted || labelFor(localId) || "附件"}
    />
  );
}

function SkillChipView({ node }: NodeViewProps) {
  const name = typeof node.attrs.name === "string" ? node.attrs.name : "";
  return <ComposerChip kind="skill" label={name} />;
}

function MentionChipView({ node }: NodeViewProps) {
  const name = typeof node.attrs.name === "string" ? node.attrs.name : "";
  return <ComposerChip kind="mention" label={name} />;
}

function composerExtensions(labelFor: (localId: string) => string) {
  const chipView = (props: NodeViewProps) => AttachmentChipView(props, labelFor);
  return [
    StarterKit.configure({
      blockquote: false,
      bulletList: false,
      codeBlock: false,
      heading: false,
      horizontalRule: false,
      listItem: false,
      link: false,
      orderedList: false,
      underline: false,
      dropcursor: false,
      gapcursor: false,
      trailingNode: false,
      code: false,
      listKeymap: false,
      undoRedo: { newGroupDelay: COMPOSER_UNDO_GROUP_DELAY },
      italic: false,
      bold: false,
      strike: false,
    }),
    ComposerUndoGroupingExtension,
    ComposerAttachmentExtension.extend({
      addAttributes() {
        return { ...this.parent?.(), label: { default: "" } };
      },
      addNodeView() {
        return ReactNodeViewRenderer(chipView);
      },
    }),
    ComposerSkillExtension.extend({
      addNodeView() {
        return ReactNodeViewRenderer(SkillChipView);
      },
    }),
    ComposerMentionExtension.extend({
      addNodeView() {
        return ReactNodeViewRenderer(MentionChipView);
      },
    }),
    ComposerMarkdownSourceExtension,
    ComposerItalicExtension,
    ComposerBoldExtension,
    ComposerStrikeExtension,
    ComposerCodeExtension,
    ComposerCodeBlockExtension.extend({
      // Tiptap 的围栏规则会造出序列化不出来的列表/引用嵌套；代码块改用快捷键插入。
      addInputRules() {
        return [];
      },
    }),
    ...ComposerBlockExtensions.map((extension) =>
      extension.name === "blockquote"
        ? extension.extend({
            addInputRules() {
              return [blockquoteInputRule];
            },
          })
        : extension.name === "horizontalRule"
          ? extension.extend({
              addInputRules() {
                return [horizontalRuleInputRule];
              },
            })
          : extension.name === "heading"
            ? extension.extend({
                addInputRules() {
                  return [headingInputRule];
                },
              })
            : extension,
    ),
    ...ComposerListExtensions.map((extension) =>
      extension.name === "listItem"
        ? extension
        : extension.extend({
            addInputRules() {
              return this.name === "bulletList"
                ? [
                    listMarkerInputRule(/^(?<marker>[*+])(?<space>\s)$/, "bulletList"),
                    // 单个 `- ` 要等下一个字符，好让 `- [ ] ` 先落到任务列表。
                    listMarkerInputRule(
                      /^(?<marker>-)(?<space>[ \t]+)(?<carried>[^\s[])$/,
                      "bulletList",
                    ),
                  ]
                : [listMarkerInputRule(/^(?<marker>\d+[.)])(?<space>\s)$/, "orderedList")];
            },
          }),
    ),
    ComposerTaskListExtension,
    ComposerTaskItemExtension.extend({
      addInputRules() {
        return [taskInputRule(this.type), bulletToTaskInputRule];
      },
    }),
  ];
}

function markdownOf(editor: Editor): string {
  return serializeEditorDoc(editor.state.doc).value;
}

/** 光标处的 markdown 偏移：选择器、引用插入都按正文偏移说话。 */
function caretMarkdown(editor: Editor): number {
  const map = serializeEditorDoc(editor.state.doc);
  return flatToMarkdown(map, pmToFlat(map, editor.state.selection.from));
}

function pmPosition(editor: Editor, markdownOffset: number): number {
  const map = serializeEditorDoc(editor.state.doc);
  return flatToPm(map, markdownToFlat(map, markdownOffset));
}

function placeCaret(editor: Editor, markdownOffset: number): void {
  const position = pmPosition(editor, markdownOffset);
  editor.commands.setTextSelection(Math.max(0, Math.min(position, editor.state.doc.content.size)));
}

export function ComposerEditor({
  value,
  caret,
  mentions = [],
  labelFor,
  readOnly,
  dragging,
  listId,
  expanded,
  activeOptionId,
  canGrow,
  onValueChange,
  onKeyDown,
  onFiles,
  onBlur,
  onHandle,
}: {
  value: string;
  caret: number | null;
  /** 可以变成点名芯片的成员名单；草稿重建时按它把 `@名字` 认回芯片。 */
  mentions?: readonly MentionCandidate[];
  labelFor: (localId: string) => string;
  readOnly: boolean;
  dragging: boolean;
  listId: string;
  expanded: boolean;
  activeOptionId?: string;
  canGrow: (length: number) => boolean;
  onValueChange: (value: string, caret: number) => void;
  onKeyDown: (event: KeyboardEvent) => boolean;
  onFiles: (files: readonly File[]) => void;
  onBlur: () => void;
  onHandle: (handle: ComposerEditorHandle | null) => void;
}) {
  // 编辑器配置只建一次；会变的回调与标签都从这份 ref 上读，避免重建编辑器。
  const latest = useRef({
    labelFor,
    mentions,
    onValueChange,
    onKeyDown,
    onFiles,
    onBlur,
    canGrow,
    caret,
  });
  latest.current = {
    labelFor,
    mentions,
    onValueChange,
    onKeyDown,
    onFiles,
    onBlur,
    canGrow,
    caret,
  };
  const extensions = useMemo(
    () => composerExtensions((localId) => latest.current.labelFor(localId)),
    [],
  );

  // 键位回调建在 useEditor 的选项里，拿不到返回值，用 ref 把实例递进去。
  const editorRef = useRef<Editor | null>(null);

  const editor = useEditor({
    extensions,
    content: buildDocJson(value, { mentions }),
    editable: !readOnly,
    // 页面是 SSR 渲的：首帧只能落后端一致，编辑器在客户端挂载后再建。
    immediatelyRender: false,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: {
        id: "message-draft",
        role: "textbox",
        "aria-multiline": "true",
        "aria-haspopup": "listbox",
        "aria-expanded": expanded ? "true" : "false",
        "aria-controls": expanded ? listId : "",
        "aria-activedescendant": expanded ? (activeOptionId ?? "") : "",
        "data-testid": "message-input",
        class: "composer-editor__input markdown-content",
      },
      handleDOMEvents: {
        keydown: (view, event) => {
          const keyboard = event as KeyboardEvent;
          if (keyboard.key === "Enter" && keyboard.isComposing) {
            event.stopPropagation();
            return true;
          }
          if (
            keyboard.key === "Tab" &&
            !keyboard.metaKey &&
            !keyboard.ctrlKey &&
            selectionInOneCodeBlock(view.state)
          ) {
            event.preventDefault();
            event.stopPropagation();
            return indentCodeBlock(view.state, keyboard.shiftKey ? "out" : "in", (tr) =>
              view.dispatch(tr),
            );
          }
          if (keyboard.key === "Enter" && !keyboard.metaKey && !keyboard.ctrlKey) {
            if (selectionInOneCodeBlock(view.state)) {
              event.preventDefault();
              event.stopPropagation();
              const dispatch = (tr: Transaction) => view.dispatch(tr.scrollIntoView());
              return (
                exitCodeBlockOnClosingFence(view.state, dispatch) ||
                exitCodeBlockOnTrailingBlankLines(view) ||
                indentedNewlineInCodeBlock(view.state, dispatch) ||
                newlineInCode(view.state, dispatch)
              );
            }
            if (convertCodeFenceOnEnter(view.state, (tr) => view.dispatch(tr))) {
              event.preventDefault();
              event.stopPropagation();
              return true;
            }
          }
          // 父层决定发送与选项移动。它说处理了就必须自己拦下默认行为，
          // 否则浏览器还会往 contenteditable 里塞一个换行。
          if (latest.current.onKeyDown(keyboard)) {
            event.preventDefault();
            return true;
          }
          if (keyboard.key !== "Enter" || keyboard.isComposing) return false;
          // 输入区里 Enter 直接发送，换行只能走 Shift+Enter。换行要是只插软换行，下一行的 markdown
          // 语法会留在同一个段落里解析不了，所以照 T3 的做法换成新块（列表里续行、空条目退出列表、
          // 空引用行退出引用）。
          const instance = editorRef.current;
          if (!instance) return false;
          event.preventDefault();
          if (
            (instance.isActive("taskItem") || instance.isActive("listItem")) &&
            splitOrLiftListItem(instance, collapseShownMarkdownSource)
          ) {
            return true;
          }
          if (hasAncestor(view.state.selection.$from, "blockquote")) {
            const parent = view.state.selection.$from.parent;
            if (parent.content.size === 0 && instance.commands.lift("blockquote")) return true;
          }
          // 换块会带着光标处的存留标记进入新块：加粗/斜体接着写是想要的，行内代码不是。
          // 光看 isActive("code") 判不出来——光标在源码揭示区的结束反引号里时它并不活跃，
          // 而换块后 PM 又会从上一段文字把 code 标记继承下来，所以这里直接把它滤掉。
          return instance
            .chain()
            .command(collapseShownMarkdownSource)
            .command(({ state, dispatch }) => splitBlockKeepMarks(state, dispatch))
            .command(({ tr }) => {
              tr.setStoredMarks(
                tr.selection.$from.marks().filter((mark) => mark.type.name !== "code"),
              );
              return true;
            })
            .scrollIntoView()
            .run();
        },
        blur: () => {
          latest.current.onBlur();
          return false;
        },
        paste: (_view, event) => {
          const list = (event as ClipboardEvent).clipboardData?.files;
          if (!list || list.length === 0) return false;
          event.preventDefault();
          latest.current.onFiles([...list]);
          return true;
        },
        drop: (_view, event) => {
          const list = (event as DragEvent).dataTransfer?.files;
          if (!list || list.length === 0) return false;
          event.preventDefault();
          // 父层的表单也有 onDrop：在这里断掉冒泡，避免文件被收两次。
          event.stopPropagation();
          latest.current.onFiles([...list]);
          return true;
        },
        beforeinput: (view, event) => {
          const input = event as InputEvent;
          if (!input.data) return false;
          const current = serializeEditorDoc(view.state.doc).value;
          if (latest.current.canGrow(current.length + input.data.length)) return false;
          event.preventDefault();
          return true;
        },
      },
    },
    onUpdate({ editor: instance }) {
      latest.current.onValueChange(markdownOf(instance), caretMarkdown(instance));
    },
    onSelectionUpdate({ editor: instance }) {
      // 光移动不改变正文，但「标签」要知道插在哪：把当前偏移报上去。
      latest.current.onValueChange(markdownOf(instance), caretMarkdown(instance));
    },
    onCreate({ editor: instance }) {
      editorRef.current = instance;
      if (latest.current.caret != null) placeCaret(instance, latest.current.caret);
    },
  });

  editorRef.current = editor ?? null;

  // 外部改写草稿（发送后清空、恢复未投递输入、选择器插入）时重建文档，光标按给定偏移落回。
  useEffect(() => {
    const instance = editorRef.current;
    if (!instance) return;
    if (markdownOf(instance) === value) {
      if (caret != null && caretMarkdown(instance) !== caret) placeCaret(instance, caret);
      return;
    }
    instance.commands.setContent(buildDocJson(value, { mentions: latest.current.mentions }), {
      emitUpdate: false,
    });
    if (caret != null) placeCaret(instance, caret);
  }, [value, caret, editor]);

  useEffect(() => {
    editorRef.current?.setEditable(!readOnly);
  }, [readOnly, editor]);

  useEffect(() => {
    if (!editor) {
      onHandle(null);
      return;
    }
    onHandle({
      focus: () => editor.commands.focus(),
      markdown: () => markdownOf(editor),
      insertAttachment: (from, to, localId, label) => {
        const fromPos = pmPosition(editor, from);
        const toPos = pmPosition(editor, to);
        editor
          .chain()
          .focus()
          .insertContentAt(
            { from: fromPos, to: toPos },
            {
              type: COMPOSER_ATTACHMENT_NODE,
              attrs: { localId, label, source: attachmentToken(localId) },
            },
          )
          .run();
        latest.current.onValueChange(markdownOf(editor), caretMarkdown(editor));
      },
      insertMention: (from, to, member) => {
        const fromPos = pmPosition(editor, from);
        const toPos = pmPosition(editor, to);
        editor
          .chain()
          .focus()
          .insertContentAt({ from: fromPos, to: toPos }, [
            {
              type: COMPOSER_MENTION_NODE,
              attrs: { memberId: member.memberId, name: member.name, source: `@${member.name}` },
            },
            { type: "text", text: " " },
          ])
          .run();
        latest.current.onValueChange(markdownOf(editor), caretMarkdown(editor));
      },
      insertSkill: (from, to, name) => {
        const fromPos = pmPosition(editor, from);
        const toPos = pmPosition(editor, to);
        // 技能 token 要被正文解析器当成独立标记，紧贴着前一个字时要先补一个空格。
        const before = fromPos > 0 ? editor.state.doc.textBetween(fromPos - 1, fromPos) : "";
        const lead = before && !/\s/u.test(before) ? [{ type: "text", text: " " }] : [];
        editor
          .chain()
          .focus()
          .insertContentAt({ from: fromPos, to: toPos }, [
            ...lead,
            { type: COMPOSER_SKILL_NODE, attrs: { name, source: skillToken(name) } },
            { type: "text", text: " " },
          ])
          .run();
        latest.current.onValueChange(markdownOf(editor), caretMarkdown(editor));
      },
      removeAttachment: (localId) => {
        let range: { from: number; to: number } | null = null;
        editor.state.doc.descendants((node, position) => {
          if (range) return false;
          if (node.type.name !== COMPOSER_ATTACHMENT_NODE) return true;
          if (String(node.attrs.localId) !== localId) return true;
          range = { from: position, to: position + node.nodeSize };
          return false;
        });
        if (!range) return false;
        const target = range;
        editor.chain().focus().deleteRange(target).run();
        latest.current.onValueChange(markdownOf(editor), caretMarkdown(editor));
        return true;
      },
    });
    return () => onHandle(null);
  }, [editor, onHandle]);

  return (
    <div
      className={`composer-editor ${dragging ? "composer-editor--dragging" : ""}`}
      data-testid="composer-editor"
    >
      <EditorContent editor={editor} />
    </div>
  );
}

export const COMPOSER_SKILL_NODE_NAME = COMPOSER_SKILL_NODE;
