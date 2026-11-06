import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  skillOptionSchema,
  type ChatSkillChoices,
  type InheritedResources,
} from "../../contracts/skill";
import { config } from "../../lib/config";
import { projectRepositoryPath } from "../../lib/repository-path";
import { getProjectProfile } from "../../domain/project-config";
import { getChat } from "../../domain/chat";
import type { ProjectContext } from "../../domain/access";

const definitionSchema = z.object({
  option: skillOptionSchema,
  filePath: z.string(),
  contentHash: z.string(),
  block: z.string(),
});
const catalogSchema = z.object({
  revision: z.string(),
  skillPaths: z.array(z.string()),
  skills: z.array(definitionSchema),
  diagnostics: z.array(z.string()),
});
export type SkillScope = Readonly<{
  projectId: string;
  agentDir: string;
  resourceCwd: string;
  sourceKey: string;
  enabled: boolean;
}>;
export type SkillCatalog = Readonly<{
  scope: SkillScope;
  revision: string;
  loadedAt: number;
  byName: ReadonlyMap<string, z.infer<typeof definitionSchema>>;
  skillPaths: readonly string[];
  diagnostics: readonly string[];
}>;
const cache = new Map<
  string,
  { generation: number; value?: SkillCatalog; pending?: Promise<SkillCatalog> }
>();
const canonical = (path: string) => (existsSync(path) ? realpathSync(path) : resolve(path));

export function resolveSkillScope(projectId: string, ctx: ProjectContext): SkillScope {
  const profile = getProjectProfile(projectId, ctx);
  const agentDir = canonical(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent"));
  const resourceCwd = canonical(
    profile.gitRemote || profile.workDirectory
      ? projectRepositoryPath(config.SPROUT_REPO_DIR, projectId, profile.workDirectory)
      : join(config.SPROUT_PI_DATA_DIR, "skill-catalog", projectId, "workspace"),
  );
  const enabled = !["false", "0"].includes(process.env.SPROUT_PI_INHERIT_HOST_RESOURCES ?? "");
  const sourceKey = createHash("sha256")
    .update(JSON.stringify({ projectId, agentDir, resourceCwd, enabled, profile }))
    .digest("hex");
  return Object.freeze({ projectId, agentDir, resourceCwd, sourceKey, enabled });
}

export async function readSkillCatalog(
  scope: SkillScope,
  mode: "display" | "fresh",
): Promise<SkillCatalog> {
  if (!scope.enabled)
    return Object.freeze({
      scope,
      revision: "disabled",
      loadedAt: Date.now(),
      byName: new Map(),
      skillPaths: [],
      diagnostics: [],
    });
  const prior = cache.get(scope.sourceKey);
  if (mode === "display") {
    if (prior?.value && Date.now() - prior.value.loadedAt < 5_000) return prior.value;
    if (prior?.pending) return prior.pending;
  }
  const entry = {
    generation: (prior?.generation ?? 0) + 1,
    value: prior?.value,
    pending: undefined as Promise<SkillCatalog> | undefined,
  };
  cache.set(scope.sourceKey, entry);
  // An empty namespace is enough before the first run; never clone or fetch for discovery.
  if (!existsSync(scope.resourceCwd)) mkdirSync(scope.resourceCwd, { recursive: true });
  const pending = new Promise<SkillCatalog>((accept, reject) => {
    const child = execFile(
      process.execPath,
      [resolve("scripts/pi-host-skill-catalog.mjs")],
      { timeout: 10_000, maxBuffer: 8 * 1024 * 1024, killSignal: "SIGKILL" },
      (error, stdout) => {
        if (error) return reject(new Error("skill_catalog_unavailable", { cause: error }));
        try {
          const wire = catalogSchema.parse(JSON.parse(stdout));
          accept(
            Object.freeze({
              scope,
              revision: wire.revision,
              loadedAt: Date.now(),
              byName: new Map(wire.skills.map((item) => [item.option.name, Object.freeze(item)])),
              skillPaths: Object.freeze(wire.skillPaths),
              diagnostics: Object.freeze(wire.diagnostics),
            }),
          );
        } catch (error) {
          reject(new Error("skill_catalog_unavailable", { cause: error }));
        }
      },
    );
    child.stdin?.end(JSON.stringify({ cwd: scope.resourceCwd, agentDir: scope.agentDir }) + "\n");
  });
  entry.pending = pending;
  try {
    const value = await pending;
    if (cache.get(scope.sourceKey) === entry) entry.value = value;
    return value;
  } finally {
    if (cache.get(scope.sourceKey) === entry) entry.pending = undefined;
  }
}

export async function listChatSkillChoices(
  chatId: string,
  ctx: ProjectContext,
): Promise<ChatSkillChoices> {
  const chat = getChat(chatId, ctx);
  const scope = resolveSkillScope(chat.projectId, ctx);
  if (!scope.enabled) return { state: "disabled", items: [] };
  try {
    const catalog = await readSkillCatalog(scope, "display");
    return { state: "ready", items: [...catalog.byName.values()].map((item) => item.option) };
  } catch {
    return { state: "unavailable", items: [] };
  }
}

export async function prepareInheritedResources(
  projectId: string,
  ctx: ProjectContext,
): Promise<InheritedResources> {
  const scope = resolveSkillScope(projectId, ctx);
  if (!scope.enabled) return { kind: "disabled" };
  // 宿主没装托管 Pi 时技能目录读不出来，继承为空仍要能开会话。
  const catalog = await readSkillCatalog(scope, "fresh").catch(() => undefined);
  return {
    kind: "enabled",
    skillRevision: catalog?.revision ?? "unavailable",
    skillPaths: catalog?.skillPaths ?? [],
    promptPaths: [join(scope.agentDir, "prompts")].filter(existsSync),
  };
}
