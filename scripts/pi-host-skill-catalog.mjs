import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { sdkRoot, resolveHostSkillPaths } from "./pi-host-skills.mjs";
import { isSkillName } from "../src/lib/skill-token.ts";

const escape = (text) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
const hash = (text) => createHash("sha256").update(text).digest("hex");
try {
  const input = createInterface({ input: process.stdin });
  let request;
  for await (const line of input) {
    request = line;
    break;
  }
  input.close();
  const config = JSON.parse(request);
  const sdk = await import(pathToFileURL(join(sdkRoot(config.agentDir), "dist/index.js")).href);
  const skillPaths = await resolveHostSkillPaths(sdk, config);
  const loaded = sdk.loadSkills({
    cwd: config.cwd,
    agentDir: config.agentDir,
    skillPaths,
    includeDefaults: false,
  });
  const diagnostics = loaded.diagnostics.map((item) => item.message);
  const skills = [];
  for (const skill of loaded.skills) {
    if (!isSkillName(skill.name)) {
      diagnostics.push(`无法表示的技能名称: ${skill.name}`);
      continue;
    }
    const raw = readFileSync(skill.filePath, "utf8");
    const reloaded = sdk.loadSkills({
      cwd: config.cwd,
      agentDir: config.agentDir,
      skillPaths: [skill.filePath],
      includeDefaults: false,
    }).skills[0];
    if (
      reloaded?.name !== skill.name ||
      reloaded.description !== skill.description ||
      readFileSync(skill.filePath, "utf8") !== raw
    ) {
      diagnostics.push(`技能在扫描时变化: ${skill.name}`);
      continue;
    }
    const body = sdk.stripFrontmatter(raw).trim();
    skills.push({
      option: { name: skill.name, description: skill.description },
      filePath: skill.filePath,
      contentHash: hash(raw),
      block: `<skill name="${escape(skill.name)}" location="${escape(skill.filePath)}">\nReferences are relative to ${dirname(skill.filePath)}.\n\n${body}\n</skill>`,
    });
  }
  const result = {
    skillPaths,
    skills,
    diagnostics,
    revision: hash(JSON.stringify({ skillPaths, skills })),
  };
  process.stdout.write(JSON.stringify(result) + "\n");
} catch (error) {
  process.stderr.write(String(error) + "\n");
  process.exitCode = 1;
}
