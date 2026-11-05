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
