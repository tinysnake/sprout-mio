import { useState } from "react";
import type { FormEvent, ReactNode } from "react";
import type { CreateMachineInput, MachineEnrollment, MachineResult } from "../../contracts/machine";
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
import { ResultError } from "../project/result-error";

export type MachineCreateValues = CreateMachineInput;

/**
 * 新建 Machine 的表单呈现。提交函数由调用方注入：正式页面接
 * `createMachine` server function，演示接固定回调。
 */
export function MachineCreateDialog({
  open,
  onOpenChange,
  submit,
  onCreated,
  trigger,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  submit: (values: MachineCreateValues) => Promise<MachineResult<MachineEnrollment>>;
  onCreated: (enrollment: MachineEnrollment) => void;
  trigger?: ReactNode;
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
    const value = new FormData(event.currentTarget).get("name");
    const name = typeof value === "string" ? value : "";
    setPending(true);
    setError(null);
    setFieldErrors({});
    try {
      const result = await submit({ name });
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
      {trigger}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建 Machine</DialogTitle>
          <DialogDescription>
            先登记身份，再按一次性票据在 macOS 上启动 Worker。名称必填，最多 80 字。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} aria-busy={pending} className="flex flex-col gap-4">
          <Field label="名称" htmlFor="machine-name" error={fieldErrors.name}>
            <Input
              id="machine-name"
              name="name"
              data-testid="machine-name-input"
              maxLength={80}
              autoComplete="off"
              disabled={pending}
            />
          </Field>
          {error && <ResultError error={error} testId="machine-create-error" />}
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={() => change(false)}
            >
              取消
            </Button>
            <Button type="submit" loading={pending} data-testid="machine-create-submit">
              创建并生成票据
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
