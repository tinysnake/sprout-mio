import { useState } from "react";
import type { ProjectWakePolicy, WakeProvider } from "../../contracts/wake-evaluation";
import type { AutomationDenial } from "./automation-page-data";
import { Button } from "../ui/button";

export type WakeProviderOption = { provider: WakeProvider; available: boolean; reason?: string };
const labels: Record<WakeProvider, string> = { small_brain: "Small Brain", jev: "JEV" };
const unavailable = [
  { provider: "small_brain", available: false, reason: "判定器配置服务尚未接入" },
  { provider: "jev", available: false, reason: "判定器配置服务尚未接入" },
] satisfies WakeProviderOption[];

/** Model and threshold metadata come from Project policy, never browser defaults. */
export function WakeProviderSelect({
  policy,
  options = unavailable,
  denial,
  onSelect,
}: {
  policy?: ProjectWakePolicy;
  options?: WakeProviderOption[];
  denial?: AutomationDenial;
  onSelect?: (provider: WakeProvider) => Promise<void>;
}) {
  const [selected, setSelected] = useState<WakeProvider | "">(policy?.provider ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocked =
    denial ??
    (!onSelect
      ? { code: "wake_provider_unavailable", reason: "判定器配置服务尚未接入，暂不能更改。" }
      : undefined);
  async function save() {
    if (!selected || !onSelect || blocked || pending) return;
    setPending(true);
    setError(null);
    try {
      await onSelect(selected);
    } catch {
      setError("保存未完成，请刷新 Project 配置后确认结果。");
    } finally {
      setPending(false);
    }
  }
  return (
    <section
      data-testid="wake-provider-select"
      className="min-w-0 space-y-3 border-b border-border py-5 text-xs break-words"
    >
      <h3 className="text-sm font-medium">自动接续判定器</h3>
      <p>当前 Project 只使用一个判定器；不可用时显示失败，不会自动切换到另一个判定器。</p>
      <p data-testid="wake-provider-current">
        {policy
          ? `当前：${labels[policy.provider]} · ${policy.model} · ${policy.thresholdVersion} · 配置版本 ${policy.configRevision}`
          : "当前判定器配置未知"}
      </p>
      <label className="flex max-w-full flex-col gap-2">
        判定器
        <select
          aria-describedby="wake-provider-reasons"
          className="h-9 w-full max-w-80 rounded-control border border-input bg-background px-3"
          value={selected}
          disabled={pending || !!blocked}
          onChange={(event) => setSelected(event.target.value as WakeProvider)}
        >
          <option value="" disabled>
            选择判定器
          </option>
          {options.map((option) => (
            <option key={option.provider} value={option.provider} disabled={!option.available}>
              {labels[option.provider]}
              {option.available ? "" : "（不可用）"}
            </option>
          ))}
        </select>
      </label>
      <div id="wake-provider-reasons" className="space-y-1 text-muted-foreground">
        {options
          .filter((option) => !option.available)
          .map((option) => (
            <p key={option.provider}>
              {labels[option.provider]} 不可用：{option.reason ?? "服务未提供可用原因"}
            </p>
          ))}
        {blocked && (
          <p>
            {blocked.reason} <code>({blocked.code})</code>
          </p>
        )}
      </div>
      <Button
        type="button"
        variant="secondary"
        disabled={
          pending ||
          !!blocked ||
          !selected ||
          !options.some((option) => option.provider === selected && option.available)
        }
        onClick={() => void save()}
      >
        保存判定器
      </Button>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
