/*
 * 移植自 T3 Code（https://github.com/pingdotgg/t3code），MIT License，
 * Copyright (c) 2026 T3 Tools Inc.。
 *
 * T3 把这两个原子节点的 Node 定义内联在 `components/ComposerPromptEditorTiptap.tsx` 里
 * （mention 254 行、skill 316 行附近）。这里抽成独立的纯逻辑扩展，供编辑器与测试共用：
 * `atom: true` + `selectable: true` 让光标不能落进 token 内部，也不允许只改它的一部分。
 */
import { Node } from "@tiptap/core";
import type { Editor, KeyboardShortcutCommand } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

export const COMPOSER_ATTACHMENT_NODE = "composer-attachment";
export const COMPOSER_SKILL_NODE = "composer-skill";

function isComposerAtom(node: ProseMirrorNode | null | undefined): node is ProseMirrorNode {
  return (
    node != null &&
    node.isAtom &&
    (node.type.name === COMPOSER_ATTACHMENT_NODE || node.type.name === COMPOSER_SKILL_NODE)
  );
}

/** 光标紧贴原子左/右边界、或原子被整体选中时的整段范围；其他位置返回 null。 */
function composerAtomRangeBeforeWithin(state: EditorState): { from: number; to: number } | null {
  const { selection } = state;
  if (selection instanceof NodeSelection) {
    return isComposerAtom(selection.node) ? { from: selection.from, to: selection.to } : null;
  }
  if (!selection.empty) return null;
  const { $from } = selection;
  const before = $from.nodeBefore;
  return isComposerAtom(before) ? { from: $from.pos - before.nodeSize, to: $from.pos } : null;
}

function composerAtomRangeAfter(state: EditorState): { from: number; to: number } | null {
  const { selection } = state;
  if (selection instanceof NodeSelection) {
    return isComposerAtom(selection.node) ? { from: selection.from, to: selection.to } : null;
  }
  if (!selection.empty) return null;
  const { $from } = selection;
  const after = $from.nodeAfter;
  return isComposerAtom(after) ? { from: $from.pos, to: $from.pos + after.nodeSize } : null;
}

/**
 * 原子右边界的一次 Backspace 必须整体删掉 token（`[[att:...]]` / 📖name 的全部字符），
 * 不能只删一个字符。T3 靠浏览器默认的 contenteditable 删除整个 chip；这里把它变成本扩展
 * 自己的 keymap，行为不依赖 node view 的 DOM 细节，headless 也能测。
 */
export function deleteComposerAtomBackward(
  state: EditorState,
  dispatch?: (tr: Transaction) => void,
): boolean {
  const range = composerAtomRangeBeforeWithin(state);
  if (!range) return false;
  if (dispatch) dispatch(state.tr.delete(range.from, range.to).scrollIntoView());
  return true;
}

/** 原子左边界的一次 Delete 同样整体删掉 token（含源码揭示状态）。 */
export function deleteComposerAtomForward(
  state: EditorState,
  dispatch?: (tr: Transaction) => void,
): boolean {
  const range = composerAtomRangeAfter(state);
  if (!range) return false;
  if (dispatch) dispatch(state.tr.delete(range.from, range.to).scrollIntoView());
  return true;
}

function composerAtomKeyboardShortcuts(): Record<string, KeyboardShortcutCommand> {
  const deleteAtom =
    (command: (state: EditorState, dispatch?: (tr: Transaction) => void) => boolean) =>
    ({ editor }: { editor: Editor }) =>
      command(editor.state, (tr) => editor.view.dispatch(tr));
  return {
    Backspace: deleteAtom(deleteComposerAtomBackward),
    Delete: deleteAtom(deleteComposerAtomForward),
  };
}

/** 正文里的 `[[att:<localId>]]`；`source` 保存原文以便逐字序列化回正文。 */
export const ComposerAttachmentExtension = Node.create({
  name: COMPOSER_ATTACHMENT_NODE,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      localId: { default: "" },
      source: { default: "" },
    };
  },
  parseHTML() {
    return [{ tag: `span[data-${COMPOSER_ATTACHMENT_NODE}]` }];
  },
  addKeyboardShortcuts() {
    return composerAtomKeyboardShortcuts();
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", { [`data-${COMPOSER_ATTACHMENT_NODE}`]: "", ...HTMLAttributes }, 0];
  },
});

/** 正文里的 `📖<name>`；`source` 保存原文以便逐字序列化回正文。 */
export const ComposerSkillExtension = Node.create({
  name: COMPOSER_SKILL_NODE,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      name: { default: "" },
      source: { default: "" },
    };
  },
  parseHTML() {
    return [{ tag: `span[data-${COMPOSER_SKILL_NODE}]` }];
  },
  addKeyboardShortcuts() {
    return composerAtomKeyboardShortcuts();
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", { [`data-${COMPOSER_SKILL_NODE}`]: "", ...HTMLAttributes }, 0];
  },
});
