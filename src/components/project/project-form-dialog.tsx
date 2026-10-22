import { useState } from "react";
import type { ComponentProps, FormEvent } from "react";
import type { FieldErrors, Project, ProjectResult } from "../../contracts/project";
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
import { ResultError } from "./result-error";

export type ProjectFormValues = { name: string; description: string };

function read(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

/**
 * 新建 Project 的表单呈现。输入尺寸只做宽松上限，字段规则留在服务端：
 * 空名称与超长描述必须真的发出请求并显示服务端的字段错误，不用原生校验提前拦掉。
 */
export function ProjectFormDialog({
  open,
  onOpenChange,
  submit,
  onCreated,
  finalFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  submit: (values: ProjectFormValues) => Promise<ProjectResult<Project>>;
  onCreated: (project: Project) => void;
  finalFocus?: ComponentProps<typeof DialogContent>["finalFocus"];
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
        description: read(form, "description"),
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
      <DialogContent finalFocus={finalFocus}>
        <DialogHeader>
          <DialogTitle>创建 Project</DialogTitle>
          <DialogDescription>名称必填，最多 80 字；描述可省略，最多 500 字。</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} aria-busy={pending} className="flex flex-col gap-4">
          <Field label="Project 名称" htmlFor="project-name" error={fieldErrors.name}>
            <Input
              id="project-name"
              name="name"
              data-testid="project-name-input"
              maxLength={200}
              disabled={pending}
            />
          </Field>
          <Field
            label="描述"
            htmlFor="project-description"
            hint="可省略，用于说明这个 Project 的协作范围。"
            error={fieldErrors.description}
          >
            <Textarea
              id="project-description"
              name="description"
              data-testid="project-description-input"
              rows={3}
              disabled={pending}
            />
          </Field>
          {error && <ResultError error={error} testId="project-form-error" />}
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={() => change(false)}
            >
              取消
            </Button>
            <Button type="submit" loading={pending} data-testid="project-submit">
              {pending ? "正在创建…" : "创建 Project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
