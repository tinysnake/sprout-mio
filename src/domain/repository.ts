import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  ProjectRepoState,
  RepoCheckout,
  RepoErrorCode,
  RepoProvenance,
  RepoSourceKind,
  RunRepoSnapshot,
} from "../contracts/repository";
import { db, sqlite } from "../db";
import { agentRun, chat, diagnosticEvent, repoCheckout, repoProvenance } from "../db/schema";
import { config } from "../lib/config";
import { directorySizeBytes, GitOpError, runGit, withRepoLock } from "../server/git";
import { assertProjectAccess } from "./access";
import type { ProjectContext } from "./access";
import { ProjectAccessError } from "./access";
import { getProjectProfile } from "./project-config";

export class RepositoryError extends Error {
  constructor(
    readonly code: RepoErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RepositoryError";
  }
}

export type RepositoryHooks = {
  beforeGitOp?: (op: string) => void | Promise<void>;
  afterGitOp?: (op: string) => void;
};

export type PreparedRepo = {
  checkoutId: string;
  projectId: string;
  path: string;
  source: string;
  sourceKind: RepoSourceKind;
  ref: string;
  commit: string;
  fresh: boolean;
  sizeBytes: number;
  fetchedAt?: Date;
};

function wrap(error: unknown, fallback: RepoErrorCode): RepositoryError {
  if (error instanceof RepositoryError) return error;
  if (error instanceof GitOpError) return new RepositoryError(error.code, error.message);
  return new RepositoryError(fallback, "Git 工作副本准备失败");
}

async function git(op: string[], hooks: RepositoryHooks): Promise<string> {
  await hooks.beforeGitOp?.(op[0]);
  try {
    const { stdout } = await runGit(op);
    hooks.afterGitOp?.(op[0]);
    return stdout.trim();
  } catch (error) {
    throw wrap(error, "repo_git_failed");
  }
}

function markPreparing(projectId: string): void {
  db.update(repoCheckout)
    .set({ status: "preparing", updatedAt: new Date() })
    .where(eq(repoCheckout.projectId, projectId))
    .run();
}

function upsertCheckout(row: {
  projectId: string;
  path: string;
  sourceKind: RepoSourceKind;
  source: string;
  ref: string;
  commit: string;
  sizeBytes: number;
  fetchedAt?: Date;
}): RepoCheckout {
  const now = new Date();
  const existing = db
    .select()
    .from(repoCheckout)
    .where(eq(repoCheckout.projectId, row.projectId))
    .get();
  const fetchedAt = row.fetchedAt ?? existing?.fetchedAt ?? undefined;
  const updated = db
    .insert(repoCheckout)
    .values({
      id: existing?.id ?? `repoc_${randomUUID()}`,
      ...row,
      fetchedAt,
      resolvedAt: now,
      status: "ready",
    })
    .onConflictDoUpdate({
      target: repoCheckout.projectId,
      set: { ...row, fetchedAt, resolvedAt: now, status: "ready", updatedAt: now },
    })
    .returning()
    .get();
  return toCheckout(updated);
}

function toCheckout(row: typeof repoCheckout.$inferSelect): RepoCheckout {
  return {
    id: row.id,
    projectId: row.projectId,
    path: row.path,
    sourceKind: row.sourceKind,
    source: row.source,
    ref: row.ref,
    commit: row.commit,
    resolvedAt: row.resolvedAt.toISOString(),
    sizeBytes: row.sizeBytes,
    status: row.status,
    updatedAt: row.updatedAt.toISOString(),
    ...(row.fetchedAt ? { fetchedAt: row.fetchedAt.toISOString() } : {}),
  };
}

async function prepareWorkingCopy(
  projectId: string,
  ctx: ProjectContext,
  profile: { gitRemote?: string; defaultBranch: string; workDirectory?: string },
  hooks: RepositoryHooks,
): Promise<PreparedRepo> {
  const managedRoot = config.SPROUT_REPO_DIR;
  const sourceKind: RepoSourceKind = profile.workDirectory ? "bound_copy" : "managed_clone";
  const path = profile.workDirectory
    ? join(managedRoot, profile.workDirectory)
    : join(managedRoot, projectId);
  const source = profile.gitRemote ?? path;
  markPreparing(projectId);

  let fresh = false;
  let fetchedAt: Date | undefined;
  let ref: string;
  let commit: string;

  if (sourceKind === "bound_copy") {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      throw new RepositoryError("repo_workdir_missing", `工作副本不存在：${path}`);
    }
    if (!stat.isDirectory())
      throw new RepositoryError("repo_workdir_missing", `工作副本不是目录：${path}`);
    try {
      await git(["-C", path, "rev-parse", "--git-dir"], hooks);
    } catch (error) {
      throw wrap(error, "repo_workdir_invalid");
    }
    if (profile.gitRemote) {
      await git(["-C", path, "fetch", profile.gitRemote, profile.defaultBranch], hooks);
      fetchedAt = new Date();
    }
    ref = await git(["-C", path, "rev-parse", "--abbrev-ref", "HEAD"], hooks);
    commit = await git(["-C", path, "rev-parse", "HEAD"], hooks);
  } else {
    const isManagedRepo = existsSync(join(path, ".git"));
    if (!isManagedRepo) {
      if (existsSync(path)) rmSync(path, { recursive: true, force: true });
      mkdirSync(managedRoot, { recursive: true });
      await git(
        ["clone", "--branch", profile.defaultBranch, "--single-branch", source, path],
        hooks,
      );
    } else {
      await git(["-C", path, "remote", "set-url", "origin", source], hooks);
      await git(["-C", path, "fetch", "origin", profile.defaultBranch], hooks);
      await git(["-C", path, "checkout", "-f", "-B", profile.defaultBranch, "FETCH_HEAD"], hooks);
    }
    fresh = true;
    fetchedAt = new Date();
    ref = profile.defaultBranch;
    commit = await git(["-C", path, "rev-parse", "HEAD"], hooks);
  }

  const sizeBytes = directorySizeBytes(path);
  if (sizeBytes > config.SPROUT_REPO_MAX_BYTES) {
    if (sourceKind === "managed_clone") rmSync(path, { recursive: true, force: true });
    throw new RepositoryError(
      "repo_disk_limit",
      `工作副本占用 ${sizeBytes} 字节，超过上限 ${config.SPROUT_REPO_MAX_BYTES} 字节` +
        (sourceKind === "managed_clone" ? "，半成品已清理" : "，未修改用户副本"),
    );
  }

  const checkout = sqlite
    .transaction(() => {
      const saved = upsertCheckout({
        projectId,
        path,
        sourceKind,
        source,
        ref,
        commit,
        sizeBytes,
        ...(fetchedAt ? { fetchedAt } : {}),
      });
      db.insert(diagnosticEvent)
        .values({
          id: `diag_${randomUUID()}`,
          at: new Date(),
          level: "info",
          event: "repository.prepared",
          requestId: ctx.requestId,
          projectId,
          message: `工作副本已就绪：${sourceKind} ${commit}`,
        })
        .run();
      return saved;
    })
    .immediate();

  return {
    checkoutId: checkout.id,
    projectId,
    path,
    source,
    sourceKind,
    ref,
    commit,
    fresh,
    sizeBytes,
    ...(fetchedAt ? { fetchedAt } : {}),
  };
}

/** Project 设置页的「立即获取」入口。Project 归属经 assertProjectAccess 校验。 */
export async function prepareProjectRepo(
  projectId: string,
  ctx: ProjectContext,
  hooks: RepositoryHooks = {},
): Promise<RepoCheckout> {
  const profile = getProjectProfile(projectId, ctx);
  if (!profile.gitRemote && !profile.workDirectory)
    throw new RepositoryError(
      "repo_unconfigured",
      "Project 未配置 gitRemote 或 workDirectory，无法获取工作副本",
    );
  return withRepoLock(projectId, async () => {
    try {
      await prepareWorkingCopy(projectId, ctx, profile, hooks);
      const row = db.select().from(repoCheckout).where(eq(repoCheckout.projectId, projectId)).get();
      if (!row) throw new RepositoryError("repo_git_failed", "工作副本状态未保存");
      return toCheckout(row);
    } catch (error) {
      throw wrap(error, "repo_git_failed");
    }
  });
}

function runRow(runId: string, ctx: ProjectContext): { runId: string; projectId: string } {
  const found = db
    .select({ run: agentRun, owner: chat })
    .from(agentRun)
    .innerJoin(chat, and(eq(chat.id, agentRun.chatId), eq(chat.projectId, agentRun.projectId)))
    .where(eq(agentRun.id, runId))
    .get();
  if (!found || found.owner.createdBy !== ctx.userId) throw new ProjectAccessError();
  return { runId, projectId: found.run.projectId };
}

/**
 * run 调度时的准备入口：Project 未配置仓库时返回 undefined（沿用分身实例目录），
 * 配置了就取用工作副本；任何取不到的状态都显式失败，不回退旧副本。
 */
export async function prepareRunRepo(
  runId: string,
  ctx: ProjectContext,
  hooks: RepositoryHooks = {},
): Promise<PreparedRepo | undefined> {
  const { projectId } = runRow(runId, ctx);
  const profile = getProjectProfile(projectId, ctx);
  if (!profile.gitRemote && !profile.workDirectory) return undefined;
  return withRepoLock(projectId, async () => {
    try {
      return await prepareWorkingCopy(projectId, ctx, profile, hooks);
    } catch (error) {
      throw wrap(error, "repo_git_failed");
    }
  });
}

/** open 成功后落 provenance，保证每行 provenance 都对应一次真实使用该副本的 run。 */
export function recordRunRepoBasis(
  runId: string,
  prepared: PreparedRepo,
  ctx: ProjectContext,
): RunRepoSnapshot {
  const { projectId } = runRow(runId, ctx);
  return sqlite
    .transaction(() => {
      const recordedAt = new Date();
      const id = `repop_${randomUUID()}`;
      db.insert(repoProvenance)
        .values({
          id,
          runId,
          projectId,
          checkoutId: prepared.checkoutId,
          path: prepared.path,
          source: prepared.source,
          sourceKind: prepared.sourceKind,
          ref: prepared.ref,
          commit: prepared.commit,
          fresh: prepared.fresh,
          sizeBytes: prepared.sizeBytes,
          recordedAt,
          ...(prepared.fetchedAt ? { fetchedAt: prepared.fetchedAt } : {}),
        })
        .run();
      return {
        provenanceId: id,
        path: prepared.path,
        source: prepared.source,
        sourceKind: prepared.sourceKind,
        ref: prepared.ref,
        commit: prepared.commit,
        fresh: prepared.fresh,
        sizeBytes: prepared.sizeBytes,
        recordedAt: recordedAt.toISOString(),
      };
    })
    .immediate();
}

export function getProjectRepoState(projectId: string, ctx: ProjectContext): ProjectRepoState {
  assertProjectAccess(ctx, projectId);
  const row = db.select().from(repoCheckout).where(eq(repoCheckout.projectId, projectId)).get();
  return {
    projectId,
    managedRoot: config.SPROUT_REPO_DIR,
    maxBytes: config.SPROUT_REPO_MAX_BYTES,
    ...(row ? { checkout: toCheckout(row) } : {}),
  };
}

export function getRunRepoBasis(runId: string, ctx: ProjectContext): RepoProvenance | undefined {
  const row = db.select().from(repoProvenance).where(eq(repoProvenance.runId, runId)).get();
  if (!row) return undefined;
  assertProjectAccess(ctx, row.projectId);
  return {
    provenanceId: row.id,
    runId: row.runId,
    projectId: row.projectId,
    path: row.path,
    source: row.source,
    sourceKind: row.sourceKind,
    ref: row.ref,
    commit: row.commit,
    fresh: row.fresh,
    sizeBytes: row.sizeBytes,
    recordedAt: row.recordedAt.toISOString(),
    ...(row.fetchedAt ? { fetchedAt: row.fetchedAt.toISOString() } : {}),
  };
}
