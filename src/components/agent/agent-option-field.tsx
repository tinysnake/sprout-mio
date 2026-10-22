import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/button";
import { Field } from "../ui/field";
import { Input } from "../ui/input";
import { Select } from "../ui/select";

/**
 * 一个可留空的选项字段（model / effort）。空值表示沿用宿主默认，
 * 但契约允许任意合法字符串，而且宿主可用列表不在前端可知范围，
 * 因此这里不编造候选项：选择「自定义」后由原生 input 承载实际取值。
 * 已存值既能继续编辑，也能清空回默认，还能在改动后恢复到打开时的原值。
 */
export function AgentOptionField({
  label,
  hint,
  value,
  initial,
  disabled,
  error,
  id,
  testId,
  onValueChange,
}: {
  label: string;
  hint: string;
  value: string;
  initial: string;
  disabled: boolean;
  error?: string;
  id: string;
  testId: string;
  onValueChange: (value: string) => void;
}) {
  const [custom, setCustom] = useState(value !== "");
  const mode = custom || value !== "" ? "custom" : "default";

  // 换了对象或服务端事实变化时，模式回到该对象自身的状态，
  // 不让上一个 profile 的「自定义」意图留在新对象上。
  const syncedInitial = useRef(initial);
  useEffect(() => {
    if (syncedInitial.current === initial) return;
    syncedInitial.current = initial;
    setCustom(initial !== "");
  }, [initial]);

  return (
    <Field label={label} htmlFor={`${id}-mode`} hint={hint} error={error}>
      <div className="flex flex-col gap-2">
        <Select
          id={`${id}-mode`}
          data-testid={testId}
          value={mode}
          disabled={disabled}
          onChange={(event) => {
            const next = event.target.value === "custom";
            setCustom(next);
            if (!next) onValueChange("");
          }}
        >
          <option value="default">使用默认</option>
          <option value="custom">自定义</option>
        </Select>
        {mode === "custom" && (
          <>
            <Input
              id={id}
              data-testid={`${testId}-custom`}
              aria-label={`${label} 自定义值`}
              value={value}
              placeholder="留空即使用默认"
              disabled={disabled}
              onChange={(event) => onValueChange(event.target.value)}
            />
            {initial !== "" && value !== initial && (
              <Button
                type="button"
                variant="link"
                size="sm"
                disabled={disabled}
                className="self-start"
                data-testid={`${testId}-restore`}
                onClick={() => onValueChange(initial)}
              >
                恢复原值 {initial}
              </Button>
            )}
          </>
        )}
      </div>
    </Field>
  );
}
