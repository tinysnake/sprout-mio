import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { AgentProfile, AgentResult } from "../../contracts/agent";
import type { FieldErrors } from "../../contracts/project";
import { ID_PREFIXES, newId } from "../../contracts/ids";
import { toAppError } from "../../contracts/result";
import type { AppError } from "../../contracts/result";
import { SettingsSection } from "../project/settings-section";
import { ResultError } from "../project/result-error";
import { Button } from "../ui/button";
import { Field } from "../ui/field";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { AgentOptionField } from "./agent-option-field";

/** 可编辑字段的草稿；空字符串表示「使用宿主默认」，与契约里的 null 对应。 */
export type AgentProfileDraft = {
  name: string;
  jobTitle: string;
  persona: string;
  model: string;
  effort: string;
};

export function draftFromProfile(profile: AgentProfile): AgentProfileDraft {
  return {
    name: profile.name,
    jobTitle: profile.jobTitle ?? "",
    persona: profile.persona,
    model: profile.model ?? "",
    effort: profile.effort ?? "",
  };
}

function sameDraft(left: AgentProfileDraft, right: AgentProfileDraft) {
  return (
    left.name === right.name &&
    left.jobTitle === right.jobTitle &&
    left.persona === right.persona &&
    left.model === right.model &&
    left.effort === right.effort
  );
}

/**
 * profile 编辑表单。保存写入下一轮快照：这里只提示语义，不假装当前轮已读到新配置。
 * 保存按钮在没有改动时禁用；失败保留草稿，成功后才提示已保存。
 */
export function AgentProfileEditor({
  profile,
  submit,
  onSaved,
}: {
  profile: AgentProfile;
  submit: (draft: AgentProfileDraft) => Promise<AgentResult<AgentProfile>>;
  onSaved: () => void;
}) {
  const initial = draftFromProfile(profile);
  const [draft, setDraft] = useState<AgentProfileDraft>(initial);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  // 同步标记以 profile 身份为主键：两个 profile 可能恰好同 timestamp，
  // 只有「同一个 profile 的新事实」才回灌草稿，换了对象就整体重新开始。
  const synced = useRef({ id: profile.id, updatedAt: profile.updatedAt });
  const currentId = useRef(profile.id);
  currentId.current = profile.id;

  useEffect(() => {
    const sameObject = synced.current.id === profile.id;
    if (sameObject && synced.current.updatedAt === profile.updatedAt) return;
    synced.current = { id: profile.id, updatedAt: profile.updatedAt };
    setDraft(draftFromProfile(profile));
    if (!sameObject) {
      setSaved(false);
      setError(null);
      setFieldErrors({});
    }
  }, [profile]);

  const dirty = !sameDraft(draft, initial);

  function change(field: keyof AgentProfileDraft, value: string) {
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
    const targetId = profile.id;
    try {
      const result = await submit(draft);
      // 已切到另一个 profile 时，旧请求的结果不能再写到新对象上。
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
      title="职位与人设"
      description={
        <span data-testid="agent-edit-note">
          修改后由下一轮运行生效；当前轮与历史回复保留原上下文。
        </span>
      }
    >
      <form
        onSubmit={handleSubmit}
        aria-busy={pending}
        className="flex max-w-[40rem] flex-col gap-5"
      >
        <Field label="名称" htmlFor="agent-edit-name" error={fieldErrors.name}>
          <Input
            id="agent-edit-name"
            data-testid="agent-edit-name"
            value={draft.name}
            maxLength={80}
            disabled={pending}
            onChange={(event) => change("name", event.target.value)}
          />
        </Field>
        <Field
          label="职位"
          htmlFor="agent-edit-job-title"
          hint={`可留空，最多 40 字；只用于展示分工，不承载权限语义。${draft.jobTitle.length} / 40`}
          error={fieldErrors.jobTitle}
        >
          <Input
            id="agent-edit-job-title"
            data-testid="agent-edit-job-title"
            value={draft.jobTitle}
            maxLength={40}
            disabled={pending}
            onChange={(event) => change("jobTitle", event.target.value)}
          />
        </Field>
        <Field
          label="人设"
          htmlFor="agent-edit-persona"
          hint={`下一轮 run 才会使用新的人设。${draft.persona.length} / 2000`}
          error={fieldErrors.persona}
        >
          <Textarea
            id="agent-edit-persona"
            data-testid="agent-edit-persona"
            value={draft.persona}
            rows={7}
            maxLength={2000}
            disabled={pending}
            onChange={(event) => change("persona", event.target.value)}
          />
        </Field>
        <div className="grid gap-5 desktop:grid-cols-2">
          <AgentOptionField
            label="model"
            hint="留空即沿用宿主 Pi 的默认模型；可用模型由宿主决定，这里不预设候选。"
            id="agent-edit-model"
            testId="agent-edit-model"
            value={draft.model}
            initial={initial.model}
            disabled={pending}
            error={fieldErrors.model}
            onValueChange={(value) => change("model", value)}
          />
          <AgentOptionField
            label="effort"
            hint="留空即沿用宿主的默认思考强度；取值由宿主解释。"
            id="agent-edit-effort"
            testId="agent-edit-effort"
            value={draft.effort}
            initial={initial.effort}
            disabled={pending}
            error={fieldErrors.effort}
            onValueChange={(value) => change("effort", value)}
          />
        </div>
        {error && <ResultError error={error} testId="agent-edit-error" />}
        <div className="flex items-center gap-3.5">
          <Button type="submit" data-testid="agent-edit-save" loading={pending} disabled={!dirty}>
            {pending ? "正在保存…" : "保存"}
          </Button>
          {saved && (
            <span
              role="status"
              data-testid="agent-edit-saved"
              className="text-xs text-muted-foreground"
            >
              已保存，下一轮生效。
            </span>
          )}
        </div>
      </form>
    </SettingsSection>
  );
}
