import { expect, it } from "vite-plus/test";
import { insertSkill, scanSkillTokens, skillQueryAt } from "../src/lib/skill-token";
import { mentionQueryAt } from "../src/components/chat/mention-picker";
it("$ and @ queries are exclusive; insertions preserve suffix and UTF-16 caret", () => {
  const body = "😀 $ho suffix";
  const query = skillQueryAt(body, 6)!;
  expect(query).toEqual({ start: 3, end: 6, query: "ho" });
  expect(mentionQueryAt(body, 6)).toBeNull();
  const first = insertSkill(body, query, "how");
  expect(first.text).toBe("😀 📖how  suffix");
  expect(first.caret).toBe("😀 📖how ".length);
  expect(skillQueryAt(first.text, first.caret)).toBeNull();
  expect(skillQueryAt("@Agent", 6)).toBeNull();
  expect(mentionQueryAt("@Agent", 6)?.query).toBe("Agent");
  const second = insertSkill(
    first.text + "$wh",
    { start: first.text.length, end: first.text.length + 3 },
    "why",
  );
  expect(scanSkillTokens(second.text).map((span) => span.name)).toEqual(["how", "why"]);
  console.log("PASS candidate: two tokens, suffix/caret, mutually exclusive $/@");
});
it("相邻两个标记之间补到两个半角空格：只隔一格时两枚各让一半，剩不下看得见的空档", () => {
  const body = "📖how $pl";
  const next = insertSkill(body, skillQueryAt(body, body.length)!, "plan-only");
  expect(next.text).toBe("📖how  📖plan-only ");
  expect(next.caret).toBe(next.text.length);
  expect(scanSkillTokens(next.text).map((span) => span.name)).toEqual(["how", "plan-only"]);

  const prepended = insertSkill("$pl📖how", { start: 0, end: 3 }, "plan-only");
  expect(prepended.text).toBe("📖plan-only  📖how");
  expect(prepended.caret).toBe("📖plan-only ".length);

  const wideBody = "📖how  $pl";
  const wide = insertSkill(
    wideBody,
    { start: wideBody.length - 3, end: wideBody.length },
    "plan-only",
  );
  expect(wide.text).toBe("📖how  📖plan-only ");
  console.log("PASS candidate: token gap is at least two half-width spaces");
});
