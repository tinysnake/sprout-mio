import { useState } from "react";
import type { FormEvent } from "react";
import type {
  MachineResult,
  ProjectMachineIntent,
  SaveProjectMachineBindingInput,
} from "../../contracts/machine";
import type { FieldErrors } from "../../contracts/project";
import { ID_PREFIXES, newId } from "../../contracts/ids";
import { toAppError } from "../../contracts/result";
import type { AppError } from "../../contracts/result";
import { Button } from "../ui/button";
import { Field } from "../ui/field";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { ResultError } from "../project/result-error";

type Binding = { intent: ProjectMachineIntent; observation: unknown } | null;

function validate(description: string, directory: string): FieldErrors {
  const errors: FieldErrors = {};
  if (!description.trim()) errors.description = "请填写说明，便于在 Project 中识别这台 Machine。";
  if (description.length > 500) errors.description = "说明最多 500 字。";
  if (directory && !directory.startsWith("/"))
    errors.directory = "工作目录必须是绝对路径，以 / 开头。";
  if (directory.length > 4096) errors.directory = "路径最多 4096 个字符。";
  if (directory.includes("\0")) errors.directory = "路径不能包含 NUL。";
  return errors;
}

/**
 * 把 Machine 加入 Project 并保存说明与工作目录。提交函数由调用方注入；
 * `expectedRevision` 来自已有绑定，成功后使用返回的 intent 更新，避免重复绑定。
 */
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
  const [intent, setIntent] = useState(binding?.intent ?? null);
  const [description, setDescription] = useState(binding?.intent.description ?? "");
  const [directory, setDirectory] = useState(binding?.intent.directory ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [saved, setSaved] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const local = validate(description, directory);
    setFieldErrors(local);
    setError(null);
    setSaved("");
    if (Object.keys(local).length > 0) return;
    setPending(true);
    try {
      const result = await submit({
        machineId,
        projectId: project.id,
        description,
        directory: directory || null,
        expectedRevision: intent?.revision ?? null,
      });
      if (!result.ok) {
        setError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }
      setIntent(result.data);
      setDescription(result.data.description);
      setDirectory(result.data.directory ?? "");
      setSaved(
        `已保存到 ${project.name}（revision ${result.data.revision}）。保存成功不代表 Worker 已验证该目录可达。`,
      );
      onSaved?.(result.data);
    } catch (cause) {
      setError(toAppError(cause, newId(ID_PREFIXES.request)));
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      data-testid="machine-binding-form"
      aria-busy={pending}
      onSubmit={handleSubmit}
      className="flex flex-col gap-4"
    >
      <div className="grid gap-4 desktop:grid-cols-2">
        <Field
          label="说明"
          htmlFor="machine-binding-description"
          hint="这个 Project 中如何使用这台 Machine，最多 500 字。"
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
        <Field
          label="工作目录"
          htmlFor="machine-binding-directory"
          hint="macOS 绝对路径；可留空表示先加入 Project、稍后设置。保存成功不证明远端路径有效。"
          error={fieldErrors.directory}
        >
          <Input
            id="machine-binding-directory"
            data-testid="machine-binding-directory"
            value={directory}
            disabled={pending}
            placeholder="/Users/example/project"
            onChange={(event) => setDirectory(event.target.value)}
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
