import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  saveProjectMachineBindingInput,
  type MachineResult,
  type ProjectMachineIntent,
  type SaveProjectMachineBindingInput,
} from "../../contracts/machine";
import { fieldErrorsFrom } from "../../contracts/project";
import type { FieldErrors } from "../../contracts/project";
import { ID_PREFIXES, newId } from "../../contracts/ids";
import { toAppError } from "../../contracts/result";
import type { AppError } from "../../contracts/result";
import { Button } from "../ui/button";
import { Field } from "../ui/field";
import { Textarea } from "../ui/textarea";
import { ResultError } from "../project/result-error";

type Binding = { intent: ProjectMachineIntent; observation: unknown } | null;

export function MachineBindingForm({
  machineId,
  project,
  binding,
  submit,
  onSaved,
}: {
  machineId: string;
  project: { id: string; name: string };
  binding: Binding;
  submit: (input: SaveProjectMachineBindingInput) => Promise<MachineResult<ProjectMachineIntent>>;
  onSaved?: (intent: ProjectMachineIntent) => void;
}) {
  const bound = binding?.intent ?? null;
  const identity = `${machineId}:${project.id}`;
  const [intent, setIntent] = useState(bound);
  const [description, setDescription] = useState(bound?.description ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [saved, setSaved] = useState("");
  const synced = useRef({ identity, revision: bound?.revision ?? null });
  const live = useRef(identity);
  live.current = identity;

  useEffect(() => {
    const matched = synced.current.identity === identity;
    const revision = bound?.revision ?? null;
    if (matched && synced.current.revision === revision) return;
    synced.current = { identity, revision };
    const nextDescription = bound?.description ?? "";
    if (!matched) {
      setIntent(bound);
      setDescription(nextDescription);
      setError(null);
      setFieldErrors({});
      setSaved("");
      return;
    }
    const dirty = description !== (intent?.description ?? "");
    if (dirty) return;
    setIntent(bound);
    setDescription(nextDescription);
  }, [identity, bound, description, intent]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const candidate: SaveProjectMachineBindingInput = {
      machineId,
      projectId: project.id,
      description,
      expectedRevision: intent?.revision ?? null,
    };
    const parsed = saveProjectMachineBindingInput.safeParse(candidate);
    setError(null);
    setSaved("");
    if (!parsed.success) {
      setFieldErrors(fieldErrorsFrom(parsed.error));
      return;
    }
    setFieldErrors({});
    const target = identity;
    setPending(true);
    try {
      const result = await submit(parsed.data);
      if (live.current !== target) return;
      if (!result.ok) {
        setError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }
      setIntent(result.data);
      setDescription(result.data.description);
      synced.current = { identity, revision: result.data.revision };
      setSaved(`已保存到 ${project.name}（revision ${result.data.revision}）。`);
      onSaved?.(result.data);
    } catch (cause) {
      if (live.current !== target) return;
      setError(toAppError(cause, newId(ID_PREFIXES.request)));
    } finally {
      if (live.current === target) setPending(false);
    }
  }

  return (
    <form
      data-testid="machine-binding-form"
      aria-busy={pending}
      onSubmit={handleSubmit}
      className="flex flex-col gap-4"
    >
      <div className="grid min-w-0 gap-4">
        <Field
          label="说明"
          htmlFor="machine-binding-description"
          hint="可留空，最多 500 字。"
          error={fieldErrors.description}
        >
          <Textarea
            id="machine-binding-description"
            data-testid="machine-binding-description"
            rows={3}
            maxLength={500}
            value={description}
            disabled={pending}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
      </div>
      {error && <ResultError error={error} testId="machine-binding-error" />}
      {saved && (
        <p
          role="status"
          data-testid="machine-binding-success"
          className="text-xs leading-6 text-status-success"
        >
          {saved}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button type="submit" loading={pending} data-testid="machine-binding-submit">
          {intent ? "保存绑定" : `加入 ${project.name}`}
        </Button>
        <span className="text-xs text-muted-foreground">
          {intent ? `当前 revision ${intent.revision}` : "首次绑定"}
        </span>
      </div>
    </form>
  );
}
