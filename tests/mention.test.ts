import { describe, expect, it } from "vite-plus/test";
import { resolveMentions, type MentionCandidate, type MentionSpan } from "../src/domain/mention";

/** 纯函数用例只构造事实：本文件不 import 任何查库的领域模块。 */
const XIAO_SHEN: MentionCandidate = { memberKind: "agent", memberId: "agp_reviewer", name: "小审" };
const XIAO_SHEN_MEI: MentionCandidate = {
  memberKind: "agent",
  memberId: "agp_reviewer_pro",
  name: "小审美",
};
const XIAO_PAO: MentionCandidate = { memberKind: "agent", memberId: "agp_runner", name: "小跑" };
const RELEASE_BOT: MentionCandidate = {
  memberKind: "human",
  memberId: "usr_release_bot",
  name: "Alice Smith",
};
const DOTTY: MentionCandidate = { memberKind: "agent", memberId: "agp_dotty", name: "v1.0(beta)+" };

const span = (
  memberKind: MentionSpan["memberKind"],
  memberId: string,
  start: number,
  end: number,
): MentionSpan => ({ memberKind, memberId, start, end });

describe("resolveMentions", () => {
  const cases: [
    title: string,
    body: string,
    candidates: MentionCandidate[],
    expected: MentionSpan[],
  ][] = [
    [
      "中文名命中，span 覆盖 @，end 开区间",
      "@小审 复核",
      [XIAO_SHEN],
      [span("agent", "agp_reviewer", 0, 3)],
    ],
    [
      "英文名带空格整段命中",
      "请 @Alice Smith 复核",
      [RELEASE_BOT],
      [span("human", "usr_release_bot", 2, 14)],
    ],
    ["@ 在句尾", "找 @小跑", [XIAO_PAO], [span("agent", "agp_runner", 2, 5)]],
    [
      "前一个 @ 后面不是名字时跳过，后一个照常命中",
      "@@小审",
      [XIAO_SHEN],
      [span("agent", "agp_reviewer", 1, 4)],
    ],
    [
      "名字是另一个名字的前缀时取最长",
      "@小审美 看看",
      [XIAO_SHEN, XIAO_SHEN_MEI],
      [span("agent", "agp_reviewer_pro", 0, 4)],
    ],
    [
      "只有「小审」这个成员时 @小审美 命中「小审」",
      "@小审美 看看",
      [XIAO_SHEN],
      // 这里命中「小审」是记录下来的取舍：不做词边界判断，成员名全局唯一且 `@` 前缀已压低误报，
      // 换成按字符类划边界会漏掉中文、带空格和带标点的真实名字。span 只盖到「@小审」。
      [span("agent", "agp_reviewer", 0, 3)],
    ],
    ["空 candidates 返回空数组", "@小审 复核", [], []],
    [
      "名字含正则元字符不影响匹配",
      "运行 @v1.0(beta)+ 看看",
      [DOTTY],
      [span("agent", "agp_dotty", 3, 15)],
    ],
    [
      "同一 body 多个不同 mention 按出现顺序返回",
      "@小跑 问 @小审",
      [XIAO_SHEN, XIAO_PAO],
      [span("agent", "agp_runner", 0, 3), span("agent", "agp_reviewer", 6, 9)],
    ],
    ["body 为空返回空数组", "", [XIAO_SHEN], []],
    ["没有 @ 前缀时不算点名", "小审 复核", [XIAO_SHEN], []],
  ];

  it.each(cases)("%s", (_title, body, candidates, expected) => {
    expect(resolveMentions(body, candidates)).toEqual(expected);
  });

  it("空名字候选不参与匹配，避免只命中一个 @", () => {
    const empty: MentionCandidate = { memberKind: "agent", memberId: "agp_empty", name: "" };
    expect(resolveMentions("@ 复核", [empty])).toEqual([]);
  });
});
