import { expect, it } from "vite-plus/test";
import { scanSkillTokens } from "../src/lib/skill-token";
import {
  assertPreparedPiMessage,
  expandSkillSpans,
  prepareSyntheticPiMessage,
  type PreparedPiMessage,
} from "../src/server/message-skills";
import type { SkillCatalog } from "../src/server/pi-host/skills";
const catalog: SkillCatalog = {
  scope: {
    projectId: "p",
    agentDir: "/host",
    resourceCwd: "/project",
    sourceKey: "scope",
    enabled: true,
  },
  revision: "one",
  loadedAt: 0,
  skillPaths: ["/skills/one/SKILL.md", "/skills/two/SKILL.md"],
  diagnostics: [],
  byName: new Map([
    [
      "one",
      {
        option: { name: "one", description: "first" },
        filePath: "/skills/one/SKILL.md",
        contentHash: "one",
        block: '<skill name="one">nested 📖two</skill>',
      },
    ],
    [
      "two",
      {
        option: { name: "two", description: "second" },
        filePath: "/skills/two/SKILL.md",
        contentHash: "two",
        block: '<skill name="two">second body</skill>',
      },
    ],
  ]),
};
const manifest = {
  kind: "enabled" as const,
  skillRevision: catalog.revision,
  skillPaths: catalog.skillPaths,
  promptPaths: [],
};
it("expands only frozen UTF-16 spans, preserving mentions, repeated skills and unknown tokens without rescanning blocks", () => {
  const body = "😀 📖one @Human 📖two 📖one 📖unknown";
  const result = expandSkillSpans("msg", body, scanSkillTokens(body), catalog, manifest);
  expect(result.text).toBe(
    '😀 <skill name="one">nested 📖two</skill> @Human <skill name="two">second body</skill> <skill name="one">nested 📖two</skill> 📖unknown',
  );
  expect(result.warnings).toEqual([{ messageId: "msg", name: "unknown", reason: "unknown_skill" }]);
  expect(expandSkillSpans("msg", body, scanSkillTokens(body), catalog, manifest)).toEqual(result);
  expect(expandSkillSpans("msg", body, [], catalog, manifest).text).toBe(body);
});
it("keeps disabled or session-missing skills literal and reports structured warnings", () => {
  const body = "📖one";
  expect(
    expandSkillSpans("msg", body, scanSkillTokens(body), catalog, { kind: "disabled" }),
  ).toEqual({
    text: body,
    warnings: [{ messageId: "msg", name: "one", reason: "inheritance_disabled" }],
  });
  expect(
    expandSkillSpans("msg", body, scanSkillTokens(body), catalog, { ...manifest, skillPaths: [] }),
  ).toEqual({
    text: body,
    warnings: [{ messageId: "msg", name: "one", reason: "session_skill_missing" }],
  });
});
it("rejects corrupt persisted offsets rather than constructing a partial prompt", () => {
  const body = "😀 📖one";
  for (const spans of [
    [{ name: "one", start: 2, end: 11 }],
    [{ name: "one", start: 3, end: 100 }],
    [...scanSkillTokens(body), ...scanSkillTokens(body)],
  ])
    expect(() => expandSkillSpans("msg", body, spans, catalog, manifest)).toThrow(
      "message_skill_corrupt",
    );
  expect(() => expandSkillSpans("msg", body, scanSkillTokens(body), null, manifest)).toThrow(
    "skill_catalog_unavailable",
  );
});
it("seals literal synthetic inputs, rejects forged transport payloads and never truncates over-limit text", () => {
  const prepared = prepareSyntheticPiMessage({
    kind: "resource_notice",
    messageId: "notice:1",
    text: "📖one",
  });
  expect(prepared.text).toBe("📖one");
  expect(() => assertPreparedPiMessage(prepared)).not.toThrow();
  expect(() =>
    assertPreparedPiMessage({
      messageId: "forged",
      text: "raw",
      warnings: [],
    } as unknown as PreparedPiMessage),
  ).toThrow("pi_message_not_prepared");
  expect(() =>
    prepareSyntheticPiMessage({
      kind: "resource_notice",
      messageId: "notice:huge",
      text: "你".repeat(100000),
    }),
  ).toThrow("skill_prompt_too_large");
});
