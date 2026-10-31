import { useState } from "react";
import type { ProjectWakePolicy, WakeProvider } from "../../contracts/wake-evaluation";
import type { WakeProviderAvailability } from "../../contracts/project";
import { Button } from "../ui/button";

export type WakeProviderOption = WakeProviderAvailability;
const labels: Record<WakeProvider, string> = { small_brain: "Small Brain", jev: "JEV" };
const reasons = {
  missing_model: "这台部署没有配置模型与阈值版本",
  missing_credentials: "这台部署没有配置凭据",
  provider_unavailable: "判定器当前不可用",
} as const;

/**
 * 判定器只能在部署配置允许的范围内选择：模型、阈值版本和凭据都在服务端。
 * 一个都不可用时这里只说明现状，不摆一个点不动的控件再解释为什么点不动。
 */
export function WakeProviderSelect({
  policy,
  options = [],
  onSelect,
}: {
  policy?: ProjectWakePolicy;
  options?: WakeProviderOption[];
  onSelect?: (provider: WakeProvider) => Promise<void>;
}) {
  const [selected, setSelected] = useState<WakeProvider | "">(policy?.provider ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const available = options.filter((option) => option.available);
  async function save() {
    if (!selected || !onSelect || pending) return;
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
          ? `当前：${labels[policy.provider]} · ${policy.model}`
          : "当前使用部署默认判定器；保存一次即可固定下来。"}
      </p>
      {options.length === 0 ? (
        <p data-testid="wake-provider-unwired" className="text-muted-foreground">
          这台部署没有提供判定器配置，暂不能更改。
        </p>
      ) : available.length === 0 ? (
        <div data-testid="wake-provider-unavailable" className="space-y-1 text-muted-foreground">
          <p>这台部署没有可用的判定器，自动接续不会做出接续判定。</p>
          {options.map((option) => (
            <p key={option.provider}>
              {labels[option.provider]}：
              {option.unavailableReason ? reasons[option.unavailableReason] : "不可用"}
            </p>
          ))}
        </div>
      ) : (
        <>
          <label className="flex max-w-full flex-col gap-2">
            判定器
            <select
              className="h-9 w-full max-w-80 rounded-control border border-input bg-background px-3"
              value={selected}
              disabled={pending}
              onChange={(event) => setSelected(event.target.value as WakeProvider)}
            >
              <option value="" disabled>
                选择判定器
              </option>
              {available.map((option) => (
                <option key={option.provider} value={option.provider}>
                  {labels[option.provider]}
                </option>
              ))}
            </select>
          </label>
          <Button
            type="button"
            variant="secondary"
            disabled={
              pending || !selected || !available.some((option) => option.provider === selected)
            }
            onClick={() => void save()}
          >
            保存判定器
          </Button>
        </>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
