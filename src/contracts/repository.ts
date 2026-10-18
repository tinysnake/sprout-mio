import { z } from "zod";
import { appIdPattern } from "./ids";
import type { FieldErrors } from "./project";
import type { AppResult } from "./result";

export const REPO_SOURCE_KINDS = ["managed_clone", "bound_copy"] as const;
export type RepoSourceKind = (typeof REPO_SOURCE_KINDS)[number];

export const REPO_CHECKOUT_STATUSES = ["preparing", "ready"] as const;
export type RepoCheckoutStatus = (typeof REPO_CHECKOUT_STATUSES)[number];

export const REPO_ERROR_CODES = [
  "repo_unconfigured",
  "repo_workdir_missing",
  "repo_workdir_invalid",
  "repo_remote_not_found",
  "repo_remote_unreachable",
  "repo_auth_failed",
  "repo_ref_not_found",
  "repo_timeout",
  "repo_disk_limit",
  "repo_git_failed",
] as const;
export type RepoErrorCode = (typeof REPO_ERROR_CODES)[number];

const uuidPattern = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
export const repoCheckoutIdSchema = z.string().regex(new RegExp(`^repoc_${uuidPattern}$`));
export const repoProvenanceIdSchema = z.string().regex(new RegExp(`^repop_${uuidPattern}$`));

export type RepoCheckout = {
  id: string;
  projectId: string;
  path: string;
  sourceKind: RepoSourceKind;
  source: string;
  ref: string;
  commit: string;
  fetchedAt?: string;
  resolvedAt: string;
  sizeBytes: number;
  status: RepoCheckoutStatus;
  updatedAt: string;
};

/** 每轮快照与 provenance 共享的分析依据。commit 必须来自 git rev-parse 实值。 */
export type RunRepoSnapshot = {
  provenanceId: string;
  path: string;
  source: string;
  sourceKind: RepoSourceKind;
  ref: string;
  commit: string;
  fresh: boolean;
  recordedAt: string;
  sizeBytes: number;
};

export type RepoProvenance = RunRepoSnapshot & {
  runId: string;
  projectId: string;
  fetchedAt?: string;
};

export type ProjectRepoState = {
  projectId: string;
  managedRoot: string;
  maxBytes: number;
  checkout?: RepoCheckout;
};

export const repoProvenanceSchema = z.object({
  provenanceId: repoProvenanceIdSchema,
  runId: z.string().min(1),
  projectId: z.string().regex(appIdPattern("prj")),
  path: z.string().min(1),
  source: z.string().min(1),
  sourceKind: z.enum(REPO_SOURCE_KINDS),
  ref: z.string().min(1),
  commit: z.string().regex(/^[0-9a-f]{40,64}$/, "commit 必须是 git rev-parse 的完整 SHA"),
  fresh: z.boolean(),
  recordedAt: z.iso.datetime(),
  sizeBytes: z.number().int().min(0),
  fetchedAt: z.iso.datetime().optional(),
});

export const prepareProjectRepoInput = z.object({
  projectId: z.string().regex(appIdPattern("prj")),
});

export type RepositoryResult<T> = AppResult<T> & { fieldErrors?: FieldErrors };
