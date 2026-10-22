import { createContext, useContext, useId } from "react";
import type { ReactNode } from "react";
import { cn } from "cn";

type FieldControlState = {
  /** 字段自己生成的控件 id：调用方省略 htmlFor / id 时，label 与原生控件仍成对关联。 */
  controlId: string;
  describedBy: string | undefined;
  invalid: boolean;
};

const FieldContext = createContext<FieldControlState | null>(null);

/**
 * Field 把控件 id、说明与错误文本的 id 交给内部的 Input / Textarea / Select，
 * 控件因此自动获得 label 关联、aria-describedby 和 aria-invalid；
 * 调用方显式传入的 id / aria-* 始终优先。
 */
export function useFieldControl(): FieldControlState | null {
  return useContext(FieldContext);
}

type FieldProps = {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
};

export function Field({ label, htmlFor, hint, error, children, className }: FieldProps) {
  const id = useId();
  const controlId = htmlFor ?? id;
  const hintId = hint ? `${id}hint` : undefined;
  const errorId = error ? `${id}error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div data-slot="field" className={cn("flex flex-col gap-1.75", className)}>
      <label htmlFor={controlId} className="text-xs font-medium">
        {label}
      </label>
      <FieldContext.Provider value={{ controlId, describedBy, invalid: Boolean(error) }}>
        {children}
      </FieldContext.Provider>
      {hint && (
        <p id={hintId} className="text-xs leading-6 text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-xs leading-6 text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
