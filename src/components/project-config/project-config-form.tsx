import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { ProjectProfile } from "../../contracts/project-config";
import type { FieldErrors, ProjectResult } from "../../contracts/project";
import { ID_PREFIXES, newId } from "../../contracts/ids";
import { toAppError } from "../../contracts/result";
import type { AppError } from "../../contracts/result";
import { Button } from "../ui/button";
import { Field } from "../ui/field";
import { Input } from "../ui/input";
import { ResultError } from "../project/result-error";
import { SettingsSection } from "../project/settings-section";

export type ProjectConfigDraft = {
  gitRemote: string;
  defaultBranch: string;
  workDirectory: string;
};

function draftFrom(profile: ProjectProfile): ProjectConfigDraft {
  return {
    gitRemote: profile.gitRemote ?? "",
    defaultBranch: profile.defaultBranch,
    workDirectory: profile.workDirectory ?? "",
  };
}

/**
 * Git remote 与工作目录是局部 patch：留空即清空，分支名必须非空。
 * 提交函数由调用方注入，正式页面接 updateProjectProfile。
 */
export function ProjectConfigForm({
  profile,
  submit,
  onSaved,
}: {
  profile: ProjectProfile;
  submit: (draft: ProjectConfigDraft) => Promise<ProjectResult<ProjectProfile>>;
  onSaved: () => void;
}) {
  const initial = draftFrom(profile);
  const [draft, setDraft] = useState(initial);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  // 以 projectId 为同步主键，同 timestamp 的不同 Project 不会互相串草稿。
  const synced = useRef({ id: profile.projectId, draft: initial });
  const currentId = useRef(profile.projectId);
  currentId.current = profile.projectId;

  useEffect(() => {
    const next = draftFrom(profile);
    const sameObject = synced.current.id === profile.projectId;
    const unchanged =
      synced.current.draft.gitRemote === next.gitRemote &&
      synced.current.draft.defaultBranch === next.defaultBranch &&
      synced.current.draft.workDirectory === next.workDirectory;
    if (sameObject && unchanged) return;
    synced.current = { id: profile.projectId, draft: next };
    setDraft(next);
    if (!sameObject) {
      setSaved(false);
      setError(null);
      setFieldErrors({});
    }
  }, [profile]);

  const dirty =
    draft.gitRemote !== initial.gitRemote ||
    draft.defaultBranch !== initial.defaultBranch ||
    draft.workDirectory !== initial.workDirectory;

  function change(field: keyof ProjectConfigDraft, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
    setSaved(false);
    setError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !dirty) return;
    setPending(true);
    setError(null);
    setSaved(false);
    setFieldErrors({});
    const targetId = profile.projectId;
    try {
      const result = await submit(draft);
      if (currentId.current !== targetId) return;
      if (!result.ok) {
        setError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }
      setSaved(true);
      onSaved();
    } catch (cause) {
      if (currentId.current !== targetId) return;
      setError(toAppError(cause, newId(ID_PREFIXES.request)));
    } finally {
      if (currentId.current === targetId) setPending(false);
    }
  }

  return (
    <SettingsSection
      title="协作配置"
      description="Chat 使用的工作副本来自这里：留空即清空该字段，分支名不能为空。"
    >
      <form
        onSubmit={handleSubmit}
        aria-busy={pending}
        className="flex max-w-[40rem] flex-col gap-5"
      >
        <Field
          label="Git remote"
          htmlFor="config-git-remote"
          hint="https:// 或 ssh:// URL；留空表示不使用托管克隆。"
          error={fieldErrors.gitRemote}
        >
          <Input
            id="config-git-remote"
            data-testid="config-git-remote"
            value={draft.gitRemote}
            disabled={pending}
            onChange={(event) => change("gitRemote", event.target.value)}
          />
        </Field>
        <div className="grid gap-5 desktop:grid-cols-2">
          <Field label="默认分支" htmlFor="config-default-branch" error={fieldErrors.defaultBranch}>
            <Input
              id="config-default-branch"
              data-testid="config-default-branch"
              value={draft.defaultBranch}
              maxLength={200}
              disabled={pending}
              onChange={(event) => change("defaultBranch", event.target.value)}
            />
          </Field>
          <Field
            label="工作目录"
            htmlFor="config-work-directory"
            hint="相对路径，留空表示使用托管目录。"
            error={fieldErrors.workDirectory}
          >
            <Input
              id="config-work-directory"
              data-testid="config-work-directory"
              value={draft.workDirectory}
              maxLength={500}
              disabled={pending}
              onChange={(event) => change("workDirectory", event.target.value)}
            />
          </Field>
        </div>
        {error && <ResultError error={error} testId="config-form-error" />}
        <div className="flex items-center gap-3.5">
          <Button type="submit" data-testid="config-save" loading={pending} disabled={!dirty}>
            {pending ? "正在保存…" : "保存配置"}
          </Button>
          {saved && (
            <span
              role="status"
              data-testid="config-saved"
              className="text-xs text-muted-foreground"
            >
              已保存。
            </span>
          )}
        </div>
      </form>
    </SettingsSection>
  );
}
