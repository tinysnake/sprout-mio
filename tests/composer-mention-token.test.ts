/*
 * 输入区点名原子：`@<name>` 只在成员名单认得出来时才是不可拆的标签。
 *
 * 这里只驱动 ProseMirror 状态（不需要 DOM）：段边界、逐字往返、整段删除、以及
 * 「正文里普通的 @ 不能被误认为 tag」这条边界。
 */
import { getSchemaByResolvedExtensions, resolveExtensions } from "@tiptap/core";
import { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import type { Transaction } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vite-plus/test";

import {
  scanMentionTokens,
  splitComposerPromptSegments,
  type MentionCandidate,
} from "../src/components/chat/tiptap/composer-prompt-segments";
import {
  buildDocJson,
  serializeEditorDoc,
} from "../src/components/chat/tiptap/composer-rich-text-doc";
import {
  COMPOSER_ATTACHMENT_NODE,
  COMPOSER_MENTION_NODE,
  COMPOSER_SKILL_NODE,
  ComposerAttachmentExtension,
  ComposerMentionExtension,
  ComposerSkillExtension,
  deleteComposerAtomBackward,
  deleteComposerAtomForward,
} from "../src/components/chat/tiptap/composer-rich-text-nodes";
import { ComposerMarkdownSourceExtension } from "../src/components/chat/tiptap/composer-markdown-source";

const ANN: MentionCandidate = { memberId: "usr_ann", name: "ann" };
const ANNA: MentionCandidate = { memberId: "usr_anna", name: "anna" };

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
    ComposerAttachmentExtension,
    ComposerMentionExtension,
    ComposerSkillExtension,
    ComposerMarkdownSourceExtension,
  ]),
);

function buildDoc(markdown: string, mentions: readonly MentionCandidate[]): ProseMirrorNode {
  const doc = ProseMirrorNode.fromJSON(schema, buildDocJson(markdown, { mentions }));
  doc.check();
  return doc;
}

function roundTrip(markdown: string, mentions: readonly MentionCandidate[]): string {
  return serializeEditorDoc(buildDoc(markdown, mentions)).value;
}

const CHIP_NODES = new Set([COMPOSER_MENTION_NODE, COMPOSER_ATTACHMENT_NODE]);

function atomNames(doc: ProseMirrorNode): string[] {
  const names: string[] = [];
  doc.descendants((node) => {
    if (CHIP_NODES.has(node.type.name)) names.push(node.type.name);
    return true;
  });
  return names;
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

describe("点名原子的识别", () => {
  it("名单里的 @名字 切成 mention 段，源码是 @名字 本身", () => {
    expect(splitComposerPromptSegments("@ann 你好", [ANN])).toEqual([
      { type: "mention", memberId: "usr_ann", name: "ann", source: "@ann" },
      { type: "text", text: " 你好" },
    ]);
  });

  it("不在名单里的 @ 留在文本里", () => {
    expect(splitComposerPromptSegments("@bob 你好", [ANN])).toEqual([
      { type: "text", text: "@bob 你好" },
    ]);
  });

  it("前面不是空白或开头时不算（邮箱不会被切成 tag）", () => {
    expect(splitComposerPromptSegments("hi@ann", [ANN])).toEqual([
      { type: "text", text: "hi@ann" },
    ]);
  });

  it("名字长的优先，短名字不会抢先切走", () => {
    expect(scanMentionTokens("@anna 在吗", [ANN, ANNA])).toEqual([
      { memberId: "usr_anna", name: "anna", start: 0, end: 5 },
    ]);
  });

  it("含空格的成员名照收，长名字仍然优先", () => {
    const spaced: MentionCandidate = { memberId: "usr_x", name: "ann lee" };
    expect(scanMentionTokens("@ann lee 在吗", [spaced])).toEqual([
      { memberId: "usr_x", name: "ann lee", start: 0, end: 8 },
    ]);
    expect(scanMentionTokens("@ann lee 在吗", [spaced, ANN])).toEqual([
      { memberId: "usr_x", name: "ann lee", start: 0, end: 8 },
    ]);
  });
});

describe("点名原子的文档往返", () => {
  it("名单里点名变成原子，序列化回原样", () => {
    const doc = buildDoc("@ann 看这个", [ANN]);
    expect(atomNames(doc)).toEqual([COMPOSER_MENTION_NODE]);
    expect(serializeEditorDoc(doc).value).toBe("@ann 看这个");
  });

  it("没有名单时保持纯文本", () => {
    const doc = buildDoc("@ann 看这个", []);
    expect(atomNames(doc)).toEqual([]);
    expect(serializeEditorDoc(doc).value).toBe("@ann 看这个");
  });

  it("点名与附件引用混排时各占一个原子", () => {
    const doc = buildDoc("@ann 看 [[att:local-1]]", [ANN]);
    expect(atomNames(doc)).toEqual([COMPOSER_MENTION_NODE, COMPOSER_ATTACHMENT_NODE]);
    expect(roundTrip("@ann 看 [[att:local-1]]", [ANN])).toBe("@ann 看 [[att:local-1]]");
  });

  it("名字带空格的点名后紧跟技能，重建后两颗原子都还在", () => {
    const spaced: MentionCandidate = { memberId: "usr_x", name: "评审 Agent" };
    const source = "@评审 Agent 📖how 看这个";
    const doc = buildDoc(source, [spaced]);
    const names: string[] = [];
    doc.descendants((node) => {
      if (node.type.name === COMPOSER_MENTION_NODE || node.type.name === COMPOSER_SKILL_NODE) {
        names.push(node.type.name);
      }
      return true;
    });
    expect(names).toEqual([COMPOSER_MENTION_NODE, COMPOSER_SKILL_NODE]);
    expect(serializeEditorDoc(doc).value).toBe(source);
  });
});

describe("点名原子的整段删除", () => {
  const doc = () => buildDoc("看 @ann 说", [ANN]);
  const atomFrom = (source: ProseMirrorNode) => {
    let from = -1;
    source.descendants((node, pos) => {
      if (node.type.name === COMPOSER_MENTION_NODE) from = pos;
      return true;
    });
    return from;
  };

  it("右边界一次 Backspace 删掉整颗，两侧正文不动", () => {
    const source = doc();
    const from = atomFrom(source);
    const next = applyCommand(
      (state, dispatch) => deleteComposerAtomBackward(state, dispatch),
      EditorState.create({ doc: source, selection: TextSelection.create(source, from + 1) }),
    );
    expect(next).not.toBeNull();
    expect(serializeEditorDoc(next!.doc).value).toBe("看  说");
  });

  it("左边界一次 Delete 删掉整颗", () => {
    const source = doc();
    const from = atomFrom(source);
    const next = applyCommand(
      (state, dispatch) => deleteComposerAtomForward(state, dispatch),
      EditorState.create({ doc: source, selection: TextSelection.create(source, from) }),
    );
    expect(next).not.toBeNull();
    expect(serializeEditorDoc(next!.doc).value).toBe("看  说");
  });

  it("光标不在原子边界时不动手", () => {
    const source = doc();
    const handled = deleteComposerAtomBackward(
      EditorState.create({ doc: source, selection: TextSelection.create(source, 1) }),
      () => {},
    );
    expect(handled).toBe(false);
  });
});
