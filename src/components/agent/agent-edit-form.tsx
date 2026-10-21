import { useState } from "react";
import type { SubmitEvent } from "react";
import type { AgentProfile } from "../../contracts/agent";
import type { FieldErrors } from "../../contracts/project";
import { ID_PREFIXES, newId } from "../../contracts/ids";
import { toAppError } from "../../contracts/result";
import type { AppError } from "../../contracts/result";
import { Button } from "../ui/button";
import { FieldError, ResultError } from "../project/result-error";
import { updateAgentProfileFn } from "../../server/functions/agent";

const inputClass = "mt-1 w-full rounded-md border border-input bg-background px-3 py-2";

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

/** 编辑走 updateAgentProfile，不改 id 也不重建分身，修改由下一轮运行读取生效。 */
export function AgentEditForm({
  profile,
  onSaved,
}: {
  profile: AgentProfile;
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
    const jobTitle = text(form, "jobTitle").trim();
    const model = text(form, "model").trim();
    const effort = text(form, "effort").trim();
    setPending(true);
    setError(null);
    setSaved(false);
    setFieldErrors({});
    try {
      const result = await updateAgentProfileFn({
        data: {
          agentProfileId: profile.id,
          name: text(form, "name"),
          jobTitle: jobTitle || null,
          persona: text(form, "persona"),
          model: model || null,
          effort: effort || null,
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
      <p data-testid="agent-edit-note" className="text-sm text-muted-foreground">
        修改后由下一轮运行生效；profile 的 ID 与历史对话不变。
      </p>
      <label className="block text-sm">
        名称
        <input
          name="name"
          data-testid="agent-edit-name"
          defaultValue={profile.name}
          maxLength={80}
          className={inputClass}
        />
        <FieldError errors={fieldErrors} name="name" />
      </label>
      <label className="block text-sm">
        职位（可留空，只用于展示）
        <input
          name="jobTitle"
          data-testid="agent-edit-job-title"
          defaultValue={profile.jobTitle ?? ""}
          maxLength={40}
          className={inputClass}
        />
        <FieldError errors={fieldErrors} name="jobTitle" />
      </label>
      <label className="block text-sm">
        人设
        <textarea
          name="persona"
          data-testid="agent-edit-persona"
          defaultValue={profile.persona}
          rows={8}
          maxLength={2000}
          className={inputClass}
        />
        <FieldError errors={fieldErrors} name="persona" />
      </label>
      <label className="block text-sm">
        model
        <select
          name="model"
          data-testid="agent-edit-model"
          defaultValue={profile.model ?? ""}
          className={inputClass}
        >
          <option value="">使用默认</option>
          {profile.model && <option value={profile.model}>{profile.model}</option>}
        </select>
        <FieldError errors={fieldErrors} name="model" />
      </label>
      <label className="block text-sm">
        effort
        <select
          name="effort"
          data-testid="agent-edit-effort"
          defaultValue={profile.effort ?? ""}
          className={inputClass}
        >
          <option value="">使用默认</option>
          {profile.effort && <option value={profile.effort}>{profile.effort}</option>}
        </select>
        <FieldError errors={fieldErrors} name="effort" />
      </label>
      {error && <ResultError error={error} testId="agent-edit-error" />}
      <div className="flex items-center gap-3">
        <Button type="submit" data-testid="agent-edit-save" disabled={pending}>
          {pending ? "正在保存…" : "保存"}
        </Button>
        {saved && (
          <span data-testid="agent-edit-saved" className="text-sm text-muted-foreground">
            已保存
          </span>
        )}
      </div>
    </form>
  );
}
