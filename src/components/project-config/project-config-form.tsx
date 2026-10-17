import { useState } from "react";
import type { SubmitEvent } from "react";
import type { ProjectProfile } from "../../contracts/project-config";
import type { FieldErrors } from "../../contracts/project";
import { ID_PREFIXES, newId } from "../../contracts/ids";
import { toAppError } from "../../contracts/result";
import type { AppError } from "../../contracts/result";
import { Button } from "../ui/button";
import { FieldError, ResultError } from "../project/result-error";
import { updateProjectProfileFn } from "../../server/functions/project-config";

const inputClass = "mt-1 w-full rounded-md border border-input bg-background px-3 py-2";

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

/** Git remote 与工作目录是局部 patch：留空即清空，分支名必须非空。 */
export function ProjectConfigForm({
  profile,
  onSaved,
}: {
  profile: ProjectProfile;
  onSaved: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    const gitRemote = text(form, "gitRemote").trim();
    const workDirectory = text(form, "workDirectory").trim();
    setPending(true);
    setError(null);
    setSaved(false);
    setFieldErrors({});
    try {
      const result = await updateProjectProfileFn({
        data: {
          projectId: profile.projectId,
          gitRemote: gitRemote || null,
          defaultBranch: text(form, "defaultBranch"),
          workDirectory: workDirectory || null,
        },
      });
      if (!result.ok) {
        setError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }
      setSaved(true);
      onSaved();
    } catch (cause) {
      setError(toAppError(cause, newId(ID_PREFIXES.request)));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} aria-busy={pending} className="max-w-xl space-y-4">
      <label className="block text-sm">
        Git remote（https:// 或 ssh:// URL，留空清空）
        <input
          name="gitRemote"
          data-testid="config-git-remote"
          defaultValue={profile.gitRemote ?? ""}
          className={inputClass}
        />
        <FieldError errors={fieldErrors} name="gitRemote" />
      </label>
      <label className="block text-sm">
        默认分支
        <input
          name="defaultBranch"
          data-testid="config-default-branch"
          defaultValue={profile.defaultBranch}
          maxLength={200}
          className={inputClass}
        />
        <FieldError errors={fieldErrors} name="defaultBranch" />
      </label>
      <label className="block text-sm">
        工作目录（相对路径，留空清空）
        <input
          name="workDirectory"
          data-testid="config-work-directory"
          defaultValue={profile.workDirectory ?? ""}
          maxLength={500}
          className={inputClass}
        />
        <FieldError errors={fieldErrors} name="workDirectory" />
      </label>
      {error && <ResultError error={error} testId="config-form-error" />}
      <div className="flex items-center gap-3">
        <Button type="submit" data-testid="config-save" disabled={pending}>
          {pending ? "正在保存…" : "保存配置"}
        </Button>
        {saved && (
          <span data-testid="config-saved" className="text-sm text-muted-foreground">
            已保存
          </span>
        )}
      </div>
    </form>
  );
}
