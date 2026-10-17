import { useState } from "react";
import type { SubmitEvent } from "react";
import type { AgentProfile } from "../../contracts/agent";
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
import { FieldError, ResultError } from "../project/result-error";
import { createAgentProfileFn } from "../../server/functions/agent";

const inputClass = "mt-1 w-full rounded-md border border-input bg-background px-3 py-2";

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

/** 新建 Agent profile 的边界是 server function，页面只按 `result.ok` 判断结果。 */
export function CreateAgentDialog({ onCreated }: { onCreated: (profile: AgentProfile) => void }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    setFieldErrors({});
    try {
      const result = await createAgentProfileFn({
        data: { name: text(form, "name"), persona: text(form, "persona") },
      });
      if (!result.ok) {
        setError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }
      setOpen(false);
      onCreated(result.data);
    } catch (cause) {
      setError(toAppError(cause, newId(ID_PREFIXES.request)));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        data-testid="new-agent-trigger"
        onClick={() => {
          setError(null);
          setFieldErrors({});
          setOpen(true);
        }}
      >
        新建 Agent
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建 Agent profile</DialogTitle>
            <DialogDescription>名称必填；人设可留空，创建后随时可编辑。</DialogDescription>
          </DialogHeader>
          <form onSubmit={submit} aria-busy={pending} className="space-y-4">
            <label className="block text-sm">
              名称
              <input
                name="name"
                data-testid="agent-name-input"
                maxLength={80}
                className={inputClass}
              />
              <FieldError errors={fieldErrors} name="name" />
            </label>
            <label className="block text-sm">
              人设
              <textarea
                name="persona"
                data-testid="agent-persona-input"
                rows={5}
                maxLength={2000}
                className={inputClass}
              />
              <FieldError errors={fieldErrors} name="persona" />
            </label>
            {error && <ResultError error={error} testId="agent-form-error" />}
            <DialogFooter>
              <Button type="submit" data-testid="agent-submit" disabled={pending}>
                {pending ? "正在创建…" : "创建"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
