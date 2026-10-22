import { useState } from "react";
import type { FormEvent } from "react";
import type { AgentProfile, AgentResult } from "../../contracts/agent";
import type { FieldErrors } from "../../contracts/project";
import { ID_PREFIXES, newId } from "../../contracts/ids";
import { toAppError } from "../../contracts/result";
import type { AppError } from "../../contracts/result";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Field } from "../ui/field";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { ResultError } from "../project/result-error";

export type AgentFormValues = { name: string; jobTitle: string; persona: string };

function read(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

/**
 * 新建 Agent 的表单呈现。提交函数由调用方注入：正式页面接 server function，
 * 开发场景接固定的演示回调，两边共用同一份界面与状态处理。
 */
export function AgentFormDialog({
  open,
  onOpenChange,
  submit,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  submit: (values: AgentFormValues) => Promise<AgentResult<AgentProfile>>;
  onCreated: (profile: AgentProfile) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  function change(next: boolean) {
    if (pending) return;
    if (next) {
      setError(null);
      setFieldErrors({});
    }
    onOpenChange(next);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    setFieldErrors({});
    try {
      const result = await submit({
        name: read(form, "name"),
        jobTitle: read(form, "jobTitle"),
        persona: read(form, "persona"),
      });
      if (!result.ok) {
        setError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }
      onOpenChange(false);
      onCreated(result.data);
    } catch (cause) {
      setError(toAppError(cause, newId(ID_PREFIXES.request)));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建 Agent profile</DialogTitle>
          <DialogDescription>名称必填；职位和人设可留空，创建后随时可编辑。</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} aria-busy={pending} className="flex flex-col gap-4">
          <Field label="名称" htmlFor="agent-name" error={fieldErrors.name}>
            <Input
              id="agent-name"
              name="name"
              data-testid="agent-name-input"
              maxLength={80}
              disabled={pending}
            />
          </Field>
          <Field
            label="职位"
            htmlFor="agent-job-title"
            hint="可留空，最多 40 字；只用于展示分工。"
            error={fieldErrors.jobTitle}
          >
            <Input
              id="agent-job-title"
              name="jobTitle"
              data-testid="agent-job-title-input"
              maxLength={40}
              disabled={pending}
            />
          </Field>
          <Field label="人设" htmlFor="agent-persona" error={fieldErrors.persona}>
            <Textarea
              id="agent-persona"
              name="persona"
              data-testid="agent-persona-input"
              rows={5}
              maxLength={2000}
              disabled={pending}
            />
          </Field>
          {error && <ResultError error={error} testId="agent-form-error" />}
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={() => change(false)}
            >
              取消
            </Button>
            <Button type="submit" loading={pending} data-testid="agent-submit">
              {pending ? "正在创建…" : "创建"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
