import { useState } from "react";
import type { SubmitEvent } from "react";
import type { FieldErrors, Project } from "../../contracts/project";
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
import { FieldError, ResultError } from "./result-error";
import { createProjectFn } from "../../server/functions/project";

const inputClass = "mt-1 w-full rounded-md border border-input bg-background px-3 py-2";

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

/** 新建 Project 的边界是 server function，页面只按 `result.ok` 判断结果。 */
export function CreateProjectDialog({ onCreated }: { onCreated: (project: Project) => void }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    const description = text(form, "description").trim();
    setPending(true);
    setError(null);
    setFieldErrors({});
    try {
      const result = await createProjectFn({
        data: {
          name: text(form, "name"),
          ...(description ? { description } : {}),
        },
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
        data-testid="new-project-trigger"
        onClick={() => {
          setError(null);
          setFieldErrors({});
          setOpen(true);
        }}
      >
        新建 Project
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建 Project</DialogTitle>
            <DialogDescription>名称必填，最多 80 字；描述可省略，最多 500 字。</DialogDescription>
          </DialogHeader>
          <form onSubmit={submit} aria-busy={pending} className="space-y-4">
            <label className="block text-sm">
              名称
              <input
                name="name"
                data-testid="project-name-input"
                maxLength={200}
                className={inputClass}
              />
              <FieldError errors={fieldErrors} name="name" />
            </label>
            <label className="block text-sm">
              描述
              <textarea
                name="description"
                data-testid="project-description-input"
                rows={3}
                className={inputClass}
              />
              <FieldError errors={fieldErrors} name="description" />
            </label>
            {error && <ResultError error={error} testId="project-form-error" />}
            <DialogFooter>
              <Button type="submit" data-testid="project-submit" disabled={pending}>
                {pending ? "正在创建…" : "创建"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
