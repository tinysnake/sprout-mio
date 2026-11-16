import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { cn } from "cn";
import { ID_PREFIXES, newId } from "../../contracts/ids";
import { toAppError } from "../../contracts/result";
import type { AppError } from "../../contracts/result";
import type { FieldErrors, Project, ProjectKind, ProjectResult } from "../../contracts/project";
import { ResultError } from "./result-error";
import { SettingsSection } from "./settings-section";
import { Button } from "../ui/button";
import { Field } from "../ui/field";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

export type ProjectBasicInfoDraft = {
  name: string;
  description: string;
  kind: ProjectKind;
  agentPrompt: string;
};

/** 三个互斥的项目类型；数组顺序就是连体选项组里从左到右的顺序。 */
const PROJECT_KIND_CHOICES: { value: ProjectKind; label: string }[] = [
  { value: "coding", label: "编程项目" },
  { value: "work", label: "工作项目" },
  { value: "custom", label: "自定义" },
];

function draftFrom(project: {
  name: string;
  description?: string;
  kind: ProjectKind;
  agentPrompt?: string | null;
}): ProjectBasicInfoDraft {
  return {
    name: project.name,
    description: project.description ?? "",
    kind: project.kind,
    agentPrompt: project.agentPrompt ?? "",
  };
}

/**
 * 改名、改描述、选项目类型与写项目提示词的呈现。提交函数由调用方注入：正式页面走 updateProject，
 * 开发场景走固定的演示回调；没有改动时保存禁用。
 */
export function ProjectBasicInfoForm({
  project,
  submit,
  onSaved,
}: {
  project: {
    id: string;
    name: string;
    description?: string;
    kind: ProjectKind;
    agentPrompt?: string | null;
  };
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
      synced.current.draft.description === next.description &&
      synced.current.draft.kind === next.kind &&
      synced.current.draft.agentPrompt === next.agentPrompt
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

  const dirty =
    draft.name !== initial.name ||
    draft.description !== initial.description ||
    draft.kind !== initial.kind ||
    draft.agentPrompt !== initial.agentPrompt;

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
      divided={false}
      title="基本信息"
      description="名称会同步到 Project 选择器；描述与类型说明这个 Project 的协作范围，提示词是给成员的补充约定。"
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
        <Field label="项目类型" error={fieldErrors.kind}>
          <div
            role="radiogroup"
            aria-label="项目类型"
            data-testid="project-edit-kind"
            className="flex w-full max-w-[22rem] overflow-hidden rounded-control border border-input bg-background"
          >
            {PROJECT_KIND_CHOICES.map((choice, index) => {
              const selected = draft.kind === choice.value;
              return (
                <label
                  key={choice.value}
                  data-testid={`project-edit-kind-${choice.value}`}
                  data-checked={selected ? "true" : "false"}
                  className={cn(
                    "flex min-h-9.5 min-w-0 flex-1 cursor-pointer items-center justify-center text-[13px] text-foreground transition-colors duration-150 has-[:focus-visible]:outline-2 has-[:focus-visible]:-outline-offset-2 has-[:focus-visible]:outline-ring max-desktop:min-h-11",
                    index > 0 && "border-l border-input",
                    // 选中格不再跟随 hover 变色，否则指针悬停时看不出哪一格在生效。
                    selected ? "bg-selected" : "hover:bg-hover",
                    pending && "pointer-events-none opacity-65",
                  )}
                >
                  <input
                    type="radio"
                    name="project-edit-kind"
                    value={choice.value}
                    checked={selected}
                    disabled={pending}
                    onChange={() => {
                      setDraft((current) => ({ ...current, kind: choice.value }));
                      setSaved(false);
                      setError(null);
                    }}
                    className="sr-only"
                  />
                  {choice.label}
                </label>
              );
            })}
          </div>
        </Field>
        <Field
          label="项目提示词"
          htmlFor="project-edit-agent-prompt"
          hint={`可留空，最多 2000 字；下一轮运行生效。${draft.agentPrompt.length} / 2000`}
          error={fieldErrors.agentPrompt}
        >
          <Textarea
            id="project-edit-agent-prompt"
            data-testid="project-edit-agent-prompt"
            value={draft.agentPrompt}
            rows={5}
            maxLength={2000}
            disabled={pending}
            placeholder="写上本项目与其它项目不同的约定，例如必须遵守的文档路径或禁止改动的目录。"
            onChange={(event) => {
              const agentPrompt = event.target.value;
              setDraft((current) => ({ ...current, agentPrompt }));
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
