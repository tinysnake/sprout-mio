import { describe, expect, it } from "vite-plus/test";
import type { MentionSpan } from "../src/contracts/chat";
import { splitMentions } from "../src/components/chat/mention-segments";

const AGENT = "agp_1";
const HUMAN = "usr_1";

function span(start: number, end: number, memberId = AGENT): MentionSpan {
  return { memberKind: memberId === HUMAN ? "human" : "agent", memberId, start, end };
}

/** 拼回原文：切片只做视觉标记，不能丢字、换字或重排。 */
function join(body: string, mentions: readonly MentionSpan[]) {
  return splitMentions(body, mentions)
    .map((segment) => segment.text)
    .join("");
}

describe("正文按点名切片", () => {
  it("没有点名时整段是普通文本", () => {
    expect(splitMentions("一条没有被点名的消息", [])).toEqual([{ text: "一条没有被点名的消息" }]);
  });

  it("单个点名切成前文、点名、后文三段", () => {
    const body = "请 @Repo 分析员 看一下这个提交";
    const mention = span(2, 11);
    expect(body.slice(mention.start, mention.end)).toBe("@Repo 分析员");
    expect(splitMentions(body, [mention])).toEqual([
      { text: "请 " },
      { text: "@Repo 分析员", span: mention },
      { text: " 看一下这个提交" },
    ]);
  });

  it("点名在行首和行尾时不补空文本片段", () => {
    const head = "开头点名 @林澈 之后还有正文";
    const headSpan = span(5, 8, HUMAN);
    expect(head.slice(headSpan.start, headSpan.end)).toBe("@林澈");
    expect(splitMentions(head, [headSpan])).toEqual([
      { text: "开头点名 " },
      { text: "@林澈", span: headSpan },
      { text: " 之后还有正文" },
    ]);

    const tail = "结尾点名 @林澈";
    const tailSpan = span(5, 8, HUMAN);
    expect(splitMentions(tail, [tailSpan])).toEqual([
      { text: "结尾点名 " },
      { text: "@林澈", span: tailSpan },
    ]);

    expect(splitMentions("@林澈", [span(0, 3, HUMAN)])).toEqual([
      { text: "@林澈", span: span(0, 3, HUMAN) },
    ]);
  });

  it("连续多个点名之间不产生空片段，也不把两个名字并成一段", () => {
    const body = "@林澈@Repo 分析员 收到";
    const first = span(0, 3, HUMAN);
    const second = span(3, 12);
    expect(body.slice(second.start, second.end)).toBe("@Repo 分析员");
    expect(splitMentions(body, [first, second])).toEqual([
      { text: "@林澈", span: first },
      { text: "@Repo 分析员", span: second },
      { text: " 收到" },
    ]);
  });

  it("同一行内的点名与跨行的正文都在切片里保留原有换行", () => {
    const body = "第一行 @林澈 和第二行\n第三行 @Repo 分析员 收尾";
    const first = span(4, 7, HUMAN);
    const second = span(17, 26);
    expect(body.slice(second.start, second.end)).toBe("@Repo 分析员");
    expect(join(body, [first, second])).toBe(body);
    expect(splitMentions(body, [first, second]).map((segment) => Boolean(segment.span))).toEqual([
      false,
      true,
      false,
      true,
      false,
    ]);
  });

  it("正文里的 @ 没被点名时保持普通文本，不被切开", () => {
    const body = "邮箱 hi@example.com 和 @未登记成员 都只是文字";
    expect(splitMentions(body, [])).toEqual([{ text: body }]);
    // 只有命中名字的那段才算点名，另一个 @ 留在文本片段里。
    const hit = span(20, 26);
    expect(body.slice(hit.start, hit.end)).toBe("@未登记成员");
    expect(splitMentions(body, [hit])).toEqual([
      { text: "邮箱 hi@example.com 和 " },
      { text: "@未登记成员", span: hit },
      { text: " 都只是文字" },
    ]);
  });

  it("乱序、越界与重叠的 span 不会丢字或抛出", () => {
    const body = "前 @A 中 @B 后";
    const first = span(2, 4);
    const second = span(7, 9);
    expect(splitMentions(body, [second, first])).toEqual([
      { text: "前 " },
      { text: "@A", span: first },
      { text: " 中 " },
      { text: "@B", span: second },
      { text: " 后" },
    ]);

    const outside = [span(0, 99), span(5, 5), span(-1, 3)];
    expect(splitMentions(body, outside)).toEqual([{ text: body }]);

    // 重叠时先出现的那段优先，被吞掉的 span 不再产生第二个片段。
    const overlapping = splitMentions(body, [first, span(3, 8)]);
    expect(overlapping.map((segment) => segment.text)).toEqual(["前 ", "@A", " 中 @B 后"]);
    expect(join(body, [first, span(3, 8)])).toBe(body);
  });

  it("空正文没有片段", () => {
    expect(splitMentions("", [])).toEqual([]);
    expect(splitMentions("", [span(0, 1)])).toEqual([]);
  });
});
