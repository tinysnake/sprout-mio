/*
 * 输入框富文本核心（移植自 T3 Code）的逻辑层回归。
 *
 * 覆盖三件事：
 * 1. Markdown ↔ ProseMirror 文档的逐字往返（块级与行内构造）；
 * 2. 附件 `[[att:<localId>]]` 与技能 `📖<name>` 两类原子 token 的段边界、保真与不可拆分；
 * 3. 原子整段删除：右边界一次 Backspace / 左边界一次 Delete（含源码揭示状态）。
 *
 * UI 集成（编辑器实例、输入规则、NodeView）不在本文件范围；这里只驱动 ProseMirror 状态，
 * 不需要 DOM。
 */
import { getSchemaByResolvedExtensions, resolveExtensions } from "@tiptap/core";
import { newlineInCode } from "@tiptap/pm/commands";
import { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { keymap } from "@tiptap/pm/keymap";
import { EditorState, NodeSelection, TextSelection } from "@tiptap/pm/state";
import type { Plugin, Transaction } from "@tiptap/pm/state";
import { TaskList } from "@tiptap/extension-task-list";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vite-plus/test";

import { splitComposerPromptSegments } from "../src/components/chat/tiptap/composer-prompt-segments";
import {
  convertCodeFenceOnEnter,
  exitCodeBlockOnClosingFence,
  exitCodeBlockOnTrailingBlankLines,
  indentCodeBlock,
  indentedNewlineInCodeBlock,
} from "../src/components/chat/tiptap/composer-code-block";
import { MARKDOWN_SOURCE_MARK } from "../src/components/chat/tiptap/composer-rich-text";
import {
  buildDocJson,
  ComposerBlockExtensions,
  ComposerCodeBlockExtension,
  ComposerCodeExtension,
  ComposerListExtensions,
  ComposerTaskItemExtension,
  flatToPm,
  markdownToFlat,
  serializeEditorDoc,
} from "../src/components/chat/tiptap/composer-rich-text-doc";
import {
  COMPOSER_ATTACHMENT_NODE,
  COMPOSER_SKILL_NODE,
  ComposerAttachmentExtension,
  ComposerSkillExtension,
  deleteComposerAtomBackward,
  deleteComposerAtomForward,
} from "../src/components/chat/tiptap/composer-rich-text-nodes";
import { ComposerMarkdownSourceExtension } from "../src/components/chat/tiptap/composer-markdown-source";
import {
  listContinuationForEnter,
  listIndentForTab,
  nextOrderedMarkerText,
} from "../src/components/chat/tiptap/composer-list-continuation";
import {
  groupUndoByChangeKind,
  markAsClipboardEdit,
} from "../src/components/chat/tiptap/composer-undo-grouping";

const ATTACHMENT_SOURCE = "[[att:local-1]]";
const SKILL_SOURCE = "📖plan";

const ATOM_NODE_NAMES = new Set([COMPOSER_ATTACHMENT_NODE, COMPOSER_SKILL_NODE]);

// 与 T3 自己的测试同构：StarterKit 只留行内标记，块级构造全部由移植的扩展提供。
const schema = getSchemaByResolvedExtensions(
  resolveExtensions([
    StarterKit.configure({
      blockquote: false,
      bulletList: false,
      codeBlock: false,
      heading: false,
      horizontalRule: false,
      listItem: false,
      orderedList: false,
      dropcursor: false,
      gapcursor: false,
      trailingNode: false,
      code: false,
    }),
    ComposerCodeExtension,
    ComposerAttachmentExtension,
    ComposerSkillExtension,
    ComposerMarkdownSourceExtension,
    TaskList,
    ComposerTaskItemExtension,
    ComposerCodeBlockExtension,
    ...ComposerListExtensions,
    ...ComposerBlockExtensions,
  ]),
);

function buildDoc(markdown: string): ProseMirrorNode {
  const doc = ProseMirrorNode.fromJSON(schema, buildDocJson(markdown));
  doc.check();
  return doc;
}

function roundTrip(markdown: string): string {
  return serializeEditorDoc(buildDoc(markdown)).value;
}

/** 文档里所有附件/技能原子，`from` 是原子左侧的文档位置（原子占 [from, from + 1)）。 */
function atomPositions(doc: ProseMirrorNode): { from: number; node: ProseMirrorNode }[] {
  const atoms: { from: number; node: ProseMirrorNode }[] = [];
  doc.descendants((node, pos) => {
    if (!node.isAtom || !ATOM_NODE_NAMES.has(node.type.name)) return true;
    atoms.push({ from: pos, node });
    return false;
  });
  return atoms;
}

function stateAt(doc: ProseMirrorNode, position: number): EditorState {
  return EditorState.create({ doc, selection: TextSelection.create(doc, position) });
}

function applyCommand(
  command: (state: EditorState, dispatch?: (tr: Transaction) => void) => boolean,
  state: EditorState,
): EditorState | null {
  const result: { state: EditorState | null } = { state: null };
  const handled = command(state, (tr) => {
    result.state = state.apply(tr);
  });
  return handled ? result.state : null;
}

/** 从原子扩展自己声明的 `addKeyboardShortcuts` 里取真绑定，而不是测试里另抄一份。 */
function atomShortcutBindings(): Record<string, unknown> {
  const bindings: Record<string, unknown> = {};
  for (const extension of [ComposerAttachmentExtension, ComposerSkillExtension]) {
    const config = extension.config as {
      addKeyboardShortcuts?: (this: unknown) => Record<string, unknown>;
    };
    const declared = config.addKeyboardShortcuts?.call({});
    for (const [name, run] of Object.entries(declared ?? {})) bindings[name] = run;
  }
  return bindings;
}

/** 按 Tiptap 的包装方式（`method({ editor })`）把绑定挂进 keymap，再用假 view 敲一次键。 */
function pressAtomKey(
  state: EditorState,
  key: "Backspace" | "Delete",
): { handled: boolean; next: EditorState | null } {
  let next: EditorState | null = null;
  const target = {
    state,
    view: {
      dispatch: (tr: Transaction) => {
        next = state.apply(tr);
      },
    },
  };
  const bindings: Record<string, () => boolean> = {};
  for (const [name, method] of Object.entries(atomShortcutBindings())) {
    // 与 Tiptap 的装配一致：PM 命令忽略 state/dispatch 参数，转调扩展声明的 method({ editor })。
    bindings[name] = () =>
      Boolean((method as (props: { editor: unknown }) => unknown)({ editor: target }));
  }
  const plugin = keymap(bindings as never);
  const view = { state, dispatch: target.view.dispatch };
  const handled =
    plugin.props.handleKeyDown?.call(
      plugin,
      view as never,
      {
        key,
        keyCode: key === "Backspace" ? 8 : 46,
        preventDefault() {},
      } as unknown as KeyboardEvent,
    ) === true;
  return { handled, next };
}

/** 源码揭示用的真实插件（markdown-source 扩展的 addProseMirrorPlugins）。 */
function markdownSourcePlugins(): Plugin[] {
  const config = ComposerMarkdownSourceExtension.config as unknown as {
    addProseMirrorPlugins?: (this: { type: unknown }) => Plugin[];
  };
  return config.addProseMirrorPlugins?.call({ type: schema.marks[MARKDOWN_SOURCE_MARK]! }) ?? [];
}

/** 源码揭示状态下敲一次删除键，返回删完后的正文与剩余原子数。 */
function deleteInRevealState(direction: "backward" | "forward"): {
  value: string;
  atoms: number;
} {
  const doc = buildDoc(`**a ${ATTACHMENT_SOURCE} b**`);
  const [atom] = atomPositions(doc);
  const caret = direction === "backward" ? atom!.from + atom!.node.nodeSize : atom!.from;
  const plugins = markdownSourcePlugins();
  const base = EditorState.create({ doc, plugins, selection: TextSelection.create(doc, 1) });
  const state = base.apply(base.tr.setSelection(TextSelection.create(base.doc, caret)));
  // 揭示发生了：粗体分隔符此刻作为原文出现在文档里。
  expect(state.doc.textContent).toContain("**");
  expect(atomPositions(state.doc)).toHaveLength(1);
  const result: { state: EditorState | null } = { state: null };
  const command = direction === "backward" ? deleteComposerAtomBackward : deleteComposerAtomForward;
  const handled = command(state, (tr) => {
    result.state = state.apply(tr);
  });
  expect(handled).toBe(true);
  return {
    value: serializeEditorDoc(result.state!.doc).value,
    atoms: atomPositions(result.state!.doc).length,
  };
}

describe("输入框富文本：块级 Markdown 往返", () => {
  it.each([
    "",
    "\n\n",
    "普通段落",
    "# 一级标题",
    "## 二级标题",
    "### 三级标题",
    "第一行\n第二行",
    "---",
    "> 引用一行",
    "> 引用一\n> 引用二",
    "- 无序一\n- 无序二",
    "- 父项\n  - 子项",
    "1. 有序一\n2. 有序二",
    "3. 从三开始\n4. 续行四",
    "01. 补零\n02. 补零二",
    "- [ ] 待办\n- [x] 完成",
    "- [ ] 父任务\n  - [ ] 子任务",
    "- item\n\n- after a blank",
    "- [ ] task\n```ts\ncode\n```\n- [ ] after",
  ])("往返 %j", (value) => {
    expect(roundTrip(value)).toBe(value);
  });

  it.each([
    "```\ncode\n```",
    "```ts\nconst a = 1;\n```",
    "~~~py\nprint(1)\n~~~",
    "before\n```ts\nconst a = 1;\n```\nafter",
    "```\n```",
    "```js title=example\ncode\n```",
    "```ts\n**not bold** stays literal\n```",
  ])("往返围栏代码块 %j", (value) => {
    expect(roundTrip(value)).toBe(value);
  });

  it("Markdown 的换行是段落分隔，段落内的硬换行节点序列化成 \\n", () => {
    const doc = buildDoc("第一行\n第二行");
    expect(doc.childCount).toBe(2);
    expect(doc.firstChild!.type.name).toBe("paragraph");
    const withBreak = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.text("第一行"),
        schema.node("hardBreak"),
        schema.text("第二行"),
      ]),
    ]);
    expect(serializeEditorDoc(withBreak).value).toBe("第一行\n第二行");
  });
});

describe("输入框富文本：行内 Markdown 往返", () => {
  it.each([
    "**粗体**",
    "*斜体*",
    "***粗斜体***",
    "~~删除线~~",
    "`行内代码`",
    "**a *b* c**",
    "*a **b** c*",
    "**`x`**",
    "~~`x`~~",
    "unmatched ** stays literal",
  ])("往返 %j", (value) => {
    expect(roundTrip(value)).toBe(value);
  });

  it.each(["[label](https://example.com/a)", "<b>bold</b>", "a <em>x</em> 与 **b** 混排"])(
    "链接与内联 HTML 原样保留：%j",
    (value) => {
      expect(roundTrip(value)).toBe(value);
    },
  );
});

describe("输入框富文本：原子 token 逐字保真", () => {
  it.each([
    ATTACHMENT_SOURCE,
    `a ${ATTACHMENT_SOURCE} b`,
    `${ATTACHMENT_SOURCE} 段首`,
    `段尾 ${ATTACHMENT_SOURCE}`,
    `- ${ATTACHMENT_SOURCE} 列表项内`,
    `**加粗 ${ATTACHMENT_SOURCE} 加粗**`,
    `**${ATTACHMENT_SOURCE}**`,
    `${ATTACHMENT_SOURCE} 紧贴 **粗体**`,
    `**粗体** 紧贴 ${ATTACHMENT_SOURCE}`,
    SKILL_SOURCE,
    `a ${SKILL_SOURCE} b`,
    `${SKILL_SOURCE} 后面还有话`,
    `- ${SKILL_SOURCE} 列表项内`,
    `**${SKILL_SOURCE}**`,
    `${ATTACHMENT_SOURCE} 与 ${SKILL_SOURCE} 并存`,
    `1. ${ATTACHMENT_SOURCE}\n2. ${SKILL_SOURCE}`,
  ])("往返 %j 不被转义或改写", (value) => {
    const map = serializeEditorDoc(buildDoc(value));
    expect(map.value).toBe(value);
    expect(map.value).not.toContain("\\");
  });

  it("每个 token 建成一个原子节点，而不是一串普通文本", () => {
    const doc = buildDoc(`a ${ATTACHMENT_SOURCE} b ${SKILL_SOURCE} c`);
    expect(atomPositions(doc)).toHaveLength(2);
    expect(atomPositions(doc).map(({ node }) => node.type.name)).toEqual([
      COMPOSER_ATTACHMENT_NODE,
      COMPOSER_SKILL_NODE,
    ]);
  });

  it("围栏代码块内的 token 保持字面文本，不生成原子", () => {
    const value = "```\n" + ATTACHMENT_SOURCE + " " + SKILL_SOURCE + "\n```";
    const doc = buildDoc(value);
    expect(atomPositions(doc)).toHaveLength(0);
    expect(serializeEditorDoc(doc).value).toBe(value);
  });

  it("literalText 模式下 token 也是纯文本，不生成原子", () => {
    const value = `a ${ATTACHMENT_SOURCE} b`;
    const doc = ProseMirrorNode.fromJSON(schema, buildDocJson(value, { literalText: true }));
    expect(atomPositions(doc)).toHaveLength(0);
    expect(serializeEditorDoc(doc).value).toBe(value);
  });
});

describe("splitComposerPromptSegments：段边界", () => {
  it("把 a [[att:local-1]] b 切成 text / attachment / text 三段并给出 source", () => {
    expect(splitComposerPromptSegments(`a ${ATTACHMENT_SOURCE} b`)).toEqual([
      { type: "text", text: "a " },
      { type: "attachment", localId: "local-1", source: ATTACHMENT_SOURCE },
      { type: "text", text: " b" },
    ]);
  });

  it("把 📖plan 切成 skill 段并给出 name 与 source", () => {
    expect(splitComposerPromptSegments(SKILL_SOURCE)).toEqual([
      { type: "skill", name: "plan", source: SKILL_SOURCE },
    ]);
  });

  it("相邻 text 合并，原子段之间不合并", () => {
    expect(splitComposerPromptSegments(`${ATTACHMENT_SOURCE} ${SKILL_SOURCE}`)).toEqual([
      { type: "attachment", localId: "local-1", source: ATTACHMENT_SOURCE },
      { type: "text", text: " " },
      { type: "skill", name: "plan", source: SKILL_SOURCE },
    ]);
  });

  it("段的 text/source 拼回正文逐字相等", () => {
    const value = `x ${SKILL_SOURCE} y ${ATTACHMENT_SOURCE} z 📖other`;
    const joined = splitComposerPromptSegments(value)
      .map((segment) => (segment.type === "text" ? segment.text : segment.source))
      .join("");
    expect(joined).toBe(value);
  });

  it("没有 token 时只有一段 text，空正文没有段", () => {
    expect(splitComposerPromptSegments("plain text")).toEqual([
      { type: "text", text: "plain text" },
    ]);
    expect(splitComposerPromptSegments("")).toEqual([]);
  });

  it("不合法的技能名不产生 skill 段", () => {
    expect(splitComposerPromptSegments("📖 plan")).toEqual([{ type: "text", text: "📖 plan" }]);
  });
});

describe("原子不可拆分", () => {
  it("原子占一个文档位置：nodeSize 为 1、没有可寻址的内部位置", () => {
    const doc = buildDoc(`a ${ATTACHMENT_SOURCE} b`);
    const [atom] = atomPositions(doc);
    expect(atom!.node.isLeaf).toBe(true);
    expect(atom!.node.nodeSize).toBe(1);
    expect(atom!.node.type.spec.atom).toBe(true);
    expect(atom!.node.type.spec.selectable).toBe(true);
  });

  it("token 内部的每个正文偏移都塌到同一个位置", () => {
    const markdown = `a ${ATTACHMENT_SOURCE} b`;
    const doc = buildDoc(markdown);
    const map = serializeEditorDoc(doc);
    const start = map.value.indexOf(ATTACHMENT_SOURCE);
    const [atom] = atomPositions(doc);
    expect(markdownToFlat(map, start + 1)).toBe(start + 1);
    for (let offset = start + 1; offset < start + ATTACHMENT_SOURCE.length; offset += 1) {
      expect(markdownToFlat(map, offset)).toBe(start + 1);
    }
    expect(flatToPm(map, start + 1)).toBe(atom!.from + atom!.node.nodeSize);
  });

  it("用 token 任意内部偏移构造的删除只整段删掉 token，不留下半个标签", () => {
    const markdown = `前 ${ATTACHMENT_SOURCE} 后`;
    const doc = buildDoc(markdown);
    const map = serializeEditorDoc(doc);
    const start = map.value.indexOf(ATTACHMENT_SOURCE);
    for (let offset = start + 1; offset < start + ATTACHMENT_SOURCE.length; offset += 1) {
      const position = flatToPm(map, markdownToFlat(map, offset));
      const state = stateAt(doc, position);
      const next = state.apply(state.tr.delete(position - 1, position));
      const value = serializeEditorDoc(next.doc).value;
      expect(value).not.toContain("[[att:");
      expect(value).not.toContain("local-1]]");
    }
  });

  it("token 旁边的普通字符照常逐个删除，token 本身保持完整", () => {
    const doc = buildDoc(`a ${ATTACHMENT_SOURCE} b`);
    const end = doc.content.size - 1;
    const state = stateAt(doc, end);
    expect(deleteComposerAtomBackward(state, () => {})).toBe(false);
    const next = state.apply(state.tr.delete(end - 1, end));
    expect(serializeEditorDoc(next.doc).value).toBe(`a ${ATTACHMENT_SOURCE} `);
  });
});

describe("删除整个标签", () => {
  it("原子右边界一次 Backspace 删掉整个 [[att:...]] 标签", () => {
    const doc = buildDoc(`前 ${ATTACHMENT_SOURCE} 后`);
    const [atom] = atomPositions(doc);
    const caret = atom!.from + atom!.node.nodeSize;
    const next = applyCommand(deleteComposerAtomBackward, stateAt(doc, caret));
    expect(next).not.toBeNull();
    expect(atomPositions(next!.doc)).toHaveLength(0);
    expect(serializeEditorDoc(next!.doc).value).toBe("前  后");
  });

  it("原子左边界一次 Delete 删掉整个 [[att:...]] 标签", () => {
    const doc = buildDoc(`前 ${ATTACHMENT_SOURCE} 后`);
    const [atom] = atomPositions(doc);
    const next = applyCommand(deleteComposerAtomForward, stateAt(doc, atom!.from));
    expect(next).not.toBeNull();
    expect(atomPositions(next!.doc)).toHaveLength(0);
    expect(serializeEditorDoc(next!.doc).value).toBe("前  后");
  });

  it("技能标签 📖plan 同样一次 Backspace 整段删掉", () => {
    const doc = buildDoc(`前 ${SKILL_SOURCE} 后`);
    const [atom] = atomPositions(doc);
    const next = applyCommand(
      deleteComposerAtomBackward,
      stateAt(doc, atom!.from + atom!.node.nodeSize),
    );
    expect(next).not.toBeNull();
    expect(serializeEditorDoc(next!.doc).value).toBe("前  后");
  });

  it("技能标签 📖plan 同样一次 Delete 整段删掉", () => {
    const doc = buildDoc(`前 ${SKILL_SOURCE} 后`);
    const [atom] = atomPositions(doc);
    const next = applyCommand(deleteComposerAtomForward, stateAt(doc, atom!.from));
    expect(next).not.toBeNull();
    expect(serializeEditorDoc(next!.doc).value).toBe("前  后");
  });

  it("位图列表项内的标签一次 Backspace 整段删掉，列表结构保留", () => {
    const doc = buildDoc(`- 列表 ${ATTACHMENT_SOURCE} 项`);
    const [atom] = atomPositions(doc);
    const next = applyCommand(
      deleteComposerAtomBackward,
      stateAt(doc, atom!.from + atom!.node.nodeSize),
    );
    expect(next).not.toBeNull();
    expect(serializeEditorDoc(next!.doc).value).toBe("- 列表  项");
  });

  it("原子被整体选中时，一次 Backspace 删掉整个标签", () => {
    const doc = buildDoc(`前 ${ATTACHMENT_SOURCE} 后`);
    const [atom] = atomPositions(doc);
    const state = EditorState.create({ doc, selection: NodeSelection.create(doc, atom!.from) });
    const next = applyCommand(deleteComposerAtomBackward, state);
    expect(next).not.toBeNull();
    expect(serializeEditorDoc(next!.doc).value).toBe("前  后");
  });

  it("扩展自己声明的 Backspace / Delete 快捷键通过 keymap 生效", () => {
    expect(Object.keys(atomShortcutBindings()).sort()).toEqual(["Backspace", "Delete"]);
    const doc = buildDoc(`前 ${ATTACHMENT_SOURCE} 后`);
    const [atom] = atomPositions(doc);
    const back = pressAtomKey(stateAt(doc, atom!.from + atom!.node.nodeSize), "Backspace");
    expect(back.handled).toBe(true);
    expect(serializeEditorDoc(back.next!.doc).value).toBe("前  后");
    const forward = pressAtomKey(stateAt(doc, atom!.from), "Delete");
    expect(forward.handled).toBe(true);
    expect(serializeEditorDoc(forward.next!.doc).value).toBe("前  后");
  });

  it("源码揭示状态下，原子右边界一次 Backspace 同样删掉整个 [[att:...]] 标签", () => {
    expect(deleteInRevealState("backward")).toEqual({ value: "**a  b**", atoms: 0 });
  });

  it("源码揭示状态下，原子左边界一次 Delete 同样删掉整个 [[att:...]] 标签", () => {
    expect(deleteInRevealState("forward")).toEqual({ value: "**a  b**", atoms: 0 });
  });
});

describe("列表续行：token 与标记识别", () => {
  it("有序列表序号递增并保留补零宽度", () => {
    expect(nextOrderedMarkerText("3.")).toBe("4.");
    expect(nextOrderedMarkerText("09)")).toBe("10)");
  });

  it("在有序列表项末尾回车续出下一号", () => {
    expect(listContinuationForEnter("3. 三", 4)).toEqual({
      start: 4,
      end: 4,
      replacement: "\n4. ",
      cursorAfter: 8,
    });
  });

  it("空列表项回车退出列表", () => {
    expect(listContinuationForEnter("- ", 2)).toEqual({
      start: 0,
      end: 2,
      replacement: "",
      cursorAfter: 0,
    });
  });

  it("光标落在附件 token 内部时不续行", () => {
    expect(listContinuationForEnter(`1. ${ATTACHMENT_SOURCE}`, 6)).toBeNull();
  });

  it("Tab 在无父项时缩进两个空格", () => {
    expect(listIndentForTab("- a", 3, 3)).toEqual({
      start: 0,
      end: 0,
      replacement: "  ",
      cursorAfter: 5,
    });
  });
});

describe("撤销分组", () => {
  const state = EditorState.create({ doc: buildDoc("a b") });

  it("按 change kind 分组，并在类型变化时收口", () => {
    expect(groupUndoByChangeKind(state.tr.insertText("x", 2), null)).toBe("insert");
    expect(groupUndoByChangeKind(state.tr.delete(2, 3), "insert")).toBe("delete");
    expect(groupUndoByChangeKind(state.tr.insertText("y", 2).delete(2, 3), "insert")).toBe("other");
  });

  it("粘贴与剪切标记为 other，不并入相邻的输入", () => {
    const pasted = markAsClipboardEdit(state.tr.insertText("y", 2), "paste");
    expect(pasted.getMeta("uiEvent")).toBe("paste");
    expect(groupUndoByChangeKind(pasted, "insert")).toBe("other");
  });
});

function codeBlockDoc(
  text: string,
  attrs: Record<string, unknown> = { language: "", fence: "```", close: "\n```" },
): ProseMirrorNode {
  const doc = schema.node("doc", null, [
    schema.node("codeBlock", attrs, text ? schema.text(text) : undefined),
  ]);
  doc.check();
  return doc;
}

/** 光标放在代码块内容的 `offset` 处（可带选区）。 */
function codeState(doc: ProseMirrorNode, offset: number, size = 0): EditorState {
  return EditorState.create({
    doc,
    selection: TextSelection.create(doc, 1 + offset, 1 + offset + size),
  });
}

/** 与编辑器里 Enter 的链路一致：退出围栏 → 带缩进换行 → 普通换行。 */
function pressEnterInCodeBlock(state: EditorState): EditorState | null {
  const result: { state: EditorState } = { state };
  const dispatch = (tr: Transaction) => {
    result.state = result.state.apply(tr);
  };
  // 像真实 view 一样：dispatch 后 view.state 就是新状态（`exitCode` 依赖这一点）。
  const view = {
    get state() {
      return result.state;
    },
    dispatch,
  };
  if (exitCodeBlockOnTrailingBlankLines(view as never)) return result.state;
  if (indentedNewlineInCodeBlock(result.state, dispatch)) return result.state;
  if (newlineInCode(result.state, dispatch)) return result.state;
  return null;
}

describe("代码块：围栏开合、退出与缩进", () => {
  it.each([
    ["```", "```", ""],
    ["```ts", "```", "ts"],
    ["~~~py", "~~~", "py"],
    ["````", "````", ""],
  ])("段落里输入 %j 回车转成代码块（fence %j、language %j）", (text, fence, language) => {
    const doc = schema.node("doc", null, [schema.node("paragraph", null, schema.text(text))]);
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 1 + text.length),
    });
    const next = applyCommand(convertCodeFenceOnEnter, state);
    expect(next).not.toBeNull();
    const block = next!.doc.firstChild!;
    expect(block.type.name).toBe("codeBlock");
    expect(block.attrs.fence).toBe(fence);
    expect(block.attrs.language).toBe(language);
    expect(next!.selection.$from.parent.type.name).toBe("codeBlock");
  });

  it("代码块内回车带上光标所在行的缩进", () => {
    const doc = codeBlockDoc("function f() {\n  body()");
    const next = applyCommand(
      (state, dispatch) => indentedNewlineInCodeBlock(state, dispatch),
      codeState(doc, doc.firstChild!.textContent.length),
    );
    expect(next).not.toBeNull();
    expect(next!.doc.firstChild!.textContent).toBe("function f() {\n  body()\n  ");
  });

  it("代码块末尾敲出关闭围栏后回车，代码块结束、光标落到新段落", () => {
    const doc = codeBlockDoc("const a = 1\n```", { language: "ts", fence: "```", close: "" });
    const next = applyCommand(
      exitCodeBlockOnClosingFence,
      codeState(doc, "const a = 1\n```".length),
    );
    expect(next).not.toBeNull();
    expect(next!.selection.$from.parent.type.name).toBe("paragraph");
    const typed = next!.apply(next!.tr.insertText("explain this"));
    expect(serializeEditorDoc(typed.doc).value).toBe("```ts\nconst a = 1\n```\nexplain this");
  });

  it("关闭围栏之后的代码行被移出代码块", () => {
    const doc = codeBlockDoc("a\n```\nb", { language: "", fence: "```", close: "" });
    const next = applyCommand(exitCodeBlockOnClosingFence, codeState(doc, "a\n```".length));
    expect(next).not.toBeNull();
    expect(serializeEditorDoc(next!.doc).value).toBe("```\na\n```\n\nb");
    expect(next!.selection.$from.parent.type.name).toBe("paragraph");
    expect(next!.selection.$from.parent.textContent).toBe("");
  });

  it("两行空行后回车离开代码块，并给未闭合的围栏补上关闭标记", () => {
    let state: EditorState | null = codeState(
      codeBlockDoc("flush()", { language: "", fence: "```", close: "" }),
      7,
    );
    for (let press = 0; press < 2; press += 1) state = pressEnterInCodeBlock(state!);
    expect(state!.doc.childCount).toBe(1);
    expect(state!.doc.firstChild!.textContent).toBe("flush()\n\n");
    state = pressEnterInCodeBlock(state!);
    expect(state!.doc.firstChild!.textContent).toBe("flush()");
    expect(state!.doc.firstChild!.attrs.close).toBe("\n```");
    expect(state!.selection.$from.parent.type.name).toBe("paragraph");
  });

  it("Tab 缩进选区触及的每一行，只到行首的行不算", () => {
    const doc = codeBlockDoc("one\ntwo\nthree");
    const all = applyCommand(
      (state, dispatch) => indentCodeBlock(state, "in", dispatch),
      codeState(doc, 1, 9),
    );
    expect(all).not.toBeNull();
    expect(all!.doc.firstChild!.textContent).toBe("  one\n  two\n  three");
    const edge = applyCommand(
      (state, dispatch) => indentCodeBlock(state, "in", dispatch),
      codeState(doc, 0, 4),
    );
    expect(edge!.doc.firstChild!.textContent).toBe("  one\ntwo\nthree");
  });

  it("选区横跨两个内容相同的代码块时，Tab 与回车都不改写文档", () => {
    const block = () =>
      schema.node("codeBlock", { language: "", fence: "```", close: "\n```" }, schema.text("  a"));
    const doc = schema.node("doc", null, [block(), block()]);
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, 2, 7) });
    expect(indentCodeBlock(state, "in", () => {})).toBe(false);
    expect(indentedNewlineInCodeBlock(state, () => {})).toBe(false);
  });
});
