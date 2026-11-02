import { describe, expect, it } from "vite-plus/test";
import {
  insertMention,
  matchMembers,
  mentionOptionId,
  mentionQueryAt,
} from "../src/components/chat/mention-picker";

const members = [
  { memberId: "usr_demo", name: "开发评审" },
  { memberId: "agp_1", name: "Repo 分析员" },
  { memberId: "agp_2", name: "前端审阅" },
  { memberId: "agp_3", name: "Repo 分析员" },
  { memberId: "agp_4", name: "   " },
];

describe("输入框 @ 候选区间", () => {
  it("在开头或空白之后的 @ 打开候选，查询词按光标截断", () => {
    expect(mentionQueryAt("@", 1)).toEqual({ start: 0, end: 1, query: "" });
    expect(mentionQueryAt("@Rep", 4)).toEqual({ start: 0, end: 4, query: "Rep" });
    expect(mentionQueryAt("请 @Re", 5)).toEqual({ start: 2, end: 5, query: "Re" });
    expect(mentionQueryAt("第一行\n@前", 6)).toEqual({ start: 4, end: 6, query: "前" });
  });

  it("正文里的普通 @ 不打开候选", () => {
    // 邮箱、@ 前是汉字或另一个 @、查询词里有空白：都不是在选成员。
    expect(mentionQueryAt("hi@example.com", 14)).toBeNull();
    expect(mentionQueryAt("报告@我", 4)).toBeNull();
    expect(mentionQueryAt("@@", 2)).toBeNull();
    expect(mentionQueryAt("@开发 评审", 6)).toBeNull();
    expect(mentionQueryAt("已选 @开发评审 ", 9)).toBeNull();
  });

  it("光标在 @ 之前时不打开", () => {
    expect(mentionQueryAt("@开发", 0)).toBeNull();
    expect(mentionQueryAt("a @b", 1)).toBeNull();
  });
});

describe("成员过滤", () => {
  it("按名字子串过滤，忽略大小写与名字两侧空白", () => {
    expect(matchMembers(members, "repo").map((member) => member.name)).toEqual(["Repo 分析员"]);
    expect(matchMembers(members, "  审阅 ").map((member) => member.name)).toEqual(["前端审阅"]);
    expect(matchMembers(members, "评审").map((member) => member.name)).toEqual(["开发评审"]);
  });

  it("空查询给出全部候选，同名只留一条，空白名字不入列", () => {
    expect(matchMembers(members, "").map((member) => member.memberId)).toEqual([
      "usr_demo",
      "agp_1",
      "agp_2",
    ]);
    expect(matchMembers(members, "不存在的名字")).toEqual([]);
  });
});

describe("插入成员名字", () => {
  it("只替换查询词，光标落在插入内容之后，不插入 id 或隐藏字符", () => {
    const query = mentionQueryAt("请 @Re 看一下", 5)!;
    const next = insertMention("请 @Re 看一下", query, "Repo 分析员");
    expect(next.value).toBe("请 @Repo 分析员  看一下");
    expect(next.caret).toBe("请 @Repo 分析员 ".length);
    expect(next.value).not.toContain("agp_");
    expect(next.value.replace(/@Repo 分析员 {2}看一下/, "")).toBe("请 ");
  });

  it("在末尾插入时正文只有名字加一个空格", () => {
    const value = "@前";
    const query = mentionQueryAt(value, value.length)!;
    const next = insertMention(value, query, "前端审阅");
    expect(next.value).toBe("@前端审阅 ");
    expect(next.caret).toBe(6);
  });

  it("插入结果再判断一次不会再打开候选", () => {
    const query = mentionQueryAt("@Re", 3)!;
    const next = insertMention("@Re", query, "Repo 分析员");
    expect(mentionQueryAt(next.value, next.caret)).toBeNull();
  });
});

describe("候选行 id", () => {
  it("按索引生成，aria-activedescendant 与渲染出的 id 同源", () => {
    expect(mentionOptionId(":r1:", 0)).toBe(":r1:-option-0");
    expect(mentionOptionId(":r1:", 2)).toBe(":r1:-option-2");
  });
});
