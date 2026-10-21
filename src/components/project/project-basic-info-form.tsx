import { useState } from "react";
import type { SubmitEvent } from "react";
import { ID_PREFIXES, newId } from "../../contracts/ids";
import { toAppError } from "../../contracts/result";
import type { AppError } from "../../contracts/result";
import type { FieldErrors } from "../../contracts/project";
import { updateProjectFn } from "../../server/functions/project";
import { Button } from "../ui/button";
import { FieldError, ResultError } from "../project/result-error";

const inputClass = "mt-1 w-full rounded-md border border-input bg-background px-3 py-2";

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

/** 改名与改描述走 updateProject，不影响对话、成员和租约。 */
export function ProjectBasicInfoForm({
  project,
  onSaved,
}: {
  project: { id: string; name: string; description?: string };
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
    const description = text(form, "description");
    setPending(true);
    setError(null);
    setSaved(false);
    setFieldErrors({});
    try {
      const result = await updateProjectFn({
        data: {
          projectId: project.id,
          name: text(form, "name"),
          description: description ? description : null,
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
      <h3 className="text-sm font-medium text-muted-foreground">基本信息</h3>
      <label className="block text-sm">
        名称
        <input
          name="name"
          data-testid="project-edit-name"
          defaultValue={project.name}
          maxLength={80}
          className={inputClass}
        />
        <FieldError errors={fieldErrors} name="name" />
      </label>
      <label className="block text-sm">
        描述（可留空）
        <textarea
          name="description"
          data-testid="project-edit-description"
          defaultValue={project.description ?? ""}
          rows={3}
          maxLength={500}
          className={inputClass}
        />
        <FieldError errors={fieldErrors} name="description" />
      </label>
      {error && <ResultError error={error} testId="project-edit-error" />}
      <div className="flex items-center gap-3">
        <Button type="submit" data-testid="project-edit-save" disabled={pending}>
          {pending ? "正在保存…" : "保存"}
        </Button>
        {saved && (
          <span data-testid="project-edit-saved" className="text-sm text-muted-foreground">
            已保存
          </span>
        )}
      </div>
    </form>
  );
}
