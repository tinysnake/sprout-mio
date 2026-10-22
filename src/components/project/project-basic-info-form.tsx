import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { ID_PREFIXES, newId } from "../../contracts/ids";
import { toAppError } from "../../contracts/result";
import type { AppError } from "../../contracts/result";
import type { FieldErrors, Project, ProjectResult } from "../../contracts/project";
import { ResultError } from "./result-error";
import { SettingsSection } from "./settings-section";
import { Button } from "../ui/button";
import { Field } from "../ui/field";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

export type ProjectBasicInfoDraft = { name: string; description: string };

function draftFrom(project: { name: string; description?: string }) {
  return { name: project.name, description: project.description ?? "" };
}

/**
 * 改名与改描述的呈现。提交函数由调用方注入：正式页面走 updateProject，
 * 开发场景走固定的演示回调；没有改动时保存禁用。
 */
export function ProjectBasicInfoForm({
  project,
  submit,
  onSaved,
}: {
  project: { id: string; name: string; description?: string };
  submit: (draft: ProjectBasicInfoDraft) => Promise<ProjectResult<Project>>;
  onSaved: () => void;
}) {
  const initial = draftFrom(project);
  const [draft, setDraft] = useState(initial);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  // 以 Project 身份为同步主键：换对象就整体重新开始，不靠字段值或时间戳判断。
  const synced = useRef({ id: project.id, draft: initial });
  const currentId = useRef(project.id);
  currentId.current = project.id;

  useEffect(() => {
    const next = draftFrom(project);
    const sameObject = synced.current.id === project.id;
    if (
      sameObject &&
      synced.current.draft.name === next.name &&
      synced.current.draft.description === next.description
    )
      return;
    synced.current = { id: project.id, draft: next };
    setDraft(next);
    if (!sameObject) {
      setSaved(false);
      setError(null);
      setFieldErrors({});
    }
  }, [project]);

  const dirty = draft.name !== initial.name || draft.description !== initial.description;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !dirty) return;
    setPending(true);
    setError(null);
    setSaved(false);
    setFieldErrors({});
    const targetId = project.id;
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
      title="基本信息"
      description="名称会同步到 Project 选择器；描述用于说明这个 Project 的协作范围。"
    >
      <form
        onSubmit={handleSubmit}
        aria-busy={pending}
        className="flex max-w-[40rem] flex-col gap-5"
      >
        <Field label="Project 名称" htmlFor="project-edit-name" error={fieldErrors.name}>
          <Input
            id="project-edit-name"
            data-testid="project-edit-name"
            value={draft.name}
            maxLength={80}
            disabled={pending}
            onChange={(event) => {
              const name = event.target.value;
              setDraft((current) => ({ ...current, name }));
              setSaved(false);
              setError(null);
            }}
          />
        </Field>
        <Field
          label="描述"
          htmlFor="project-edit-description"
          hint="可留空，最多 500 字。"
          error={fieldErrors.description}
        >
          <Textarea
            id="project-edit-description"
            data-testid="project-edit-description"
            value={draft.description}
            rows={3}
            maxLength={500}
            disabled={pending}
            onChange={(event) => {
              const description = event.target.value;
              setDraft((current) => ({ ...current, description }));
              setSaved(false);
              setError(null);
            }}
          />
        </Field>
        {error && <ResultError error={error} testId="project-edit-error" />}
        <div className="flex items-center gap-3.5">
          <Button type="submit" data-testid="project-edit-save" loading={pending} disabled={!dirty}>
            {pending ? "正在保存…" : "保存"}
          </Button>
          {saved && (
            <span
              role="status"
              data-testid="project-edit-saved"
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
