import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { ChannelConfigView } from "../../contracts/channel";
import type { AppError } from "../../contracts/result";
import { getChannelConfigsFn, saveChannelConfigFn } from "../../server/functions/channels";
import { Button } from "../ui/button";
import { Field } from "../ui/field";
import { Input } from "../ui/input";
import {
  FEISHU_CONFIG_DESCRIPTION,
  FEISHU_SECRET_EMPTY_HINT,
  FEISHU_SECRET_KEPT_HINT,
  channelConfigDraft,
  channelConfigFailureText,
  channelConfigSaveInput,
  channelConfigStatusLabel,
  type ChannelConfigDraft,
} from "./channel-config-copy";
import { ResultError } from "./result-error";
import { SettingsSection } from "./settings-section";

const EMPTY_DRAFT: ChannelConfigDraft = {
  enabled: false,
  origin: "https://open.feishu.cn",
  appId: "",
  appSecret: "",
};

function translated(error: AppError): AppError {
  return { ...error, message: channelConfigFailureText(error) };
}

function StatusChip({ children }: { children: string }) {
  return (
    <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
      {children}
    </span>
  );
}

export function FeishuConfigPanel({
  projectId,
  onSaved,
}: {
  projectId: string;
  onSaved?: () => void;
}) {
  const [view, setView] = useState<ChannelConfigView | null>(null);
  const [draft, setDraft] = useState<ChannelConfigDraft>(EMPTY_DRAFT);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [loadError, setLoadError] = useState<AppError | null>(null);
  const [saveError, setSaveError] = useState<AppError | null>(null);
  const [saved, setSaved] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(null);
    void (async () => {
      const result = await getChannelConfigsFn({ data: { projectId } });
      if (!active) return;
      if (!result.ok) {
        setLoadError(translated(result.error));
        setLoading(false);
        return;
      }
      const feishu = result.data.find((item) => item.kind === "feishu");
      if (feishu) {
        setView(feishu);
        setDraft(channelConfigDraft(feishu));
      }
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [projectId, attempt]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!view || pending) return;
    setPending(true);
    setSaveError(null);
    setSaved(false);
    const result = await saveChannelConfigFn({
      data: channelConfigSaveInput(projectId, draft, view),
    });
    setPending(false);
    if (!result.ok) {
      setSaveError(translated(result.error));
      return;
    }
    setView(result.data);
    setDraft(channelConfigDraft(result.data));
    setSaved(true);
    onSaved?.();
  }

  const status = loading ? "读取中" : view ? channelConfigStatusLabel(view) : "未配置";

  return (
    <SettingsSection
      title="飞书应用配置"
      description={FEISHU_CONFIG_DESCRIPTION}
      actions={
        <span data-testid="feishu-config-status">
          <StatusChip>{status}</StatusChip>
        </span>
      }
      testId="feishu-config-panel"
    >
      {loadError ? (
        <div className="space-y-3">
          <ResultError error={loadError} testId="feishu-config-error" />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            data-testid="feishu-config-retry"
            onClick={() => setAttempt((value) => value + 1)}
          >
            重新读取
          </Button>
        </div>
      ) : loading || !view ? (
        <p className="text-sm text-muted-foreground">正在读取配置…</p>
      ) : (
        <form className="space-y-4" onSubmit={save}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="App ID"
              hint="开放平台「凭证与基础信息」里的 App ID，形如 cli_ 开头的一串。"
            >
              <Input
                data-testid="feishu-config-app-id"
                value={draft.appId}
                autoComplete="off"
                spellCheck={false}
                placeholder="cli_..."
                onChange={(event) => setDraft({ ...draft, appId: event.target.value })}
              />
            </Field>
            <Field
              label="App Secret"
              hint={view.hasAppSecret ? FEISHU_SECRET_KEPT_HINT : FEISHU_SECRET_EMPTY_HINT}
            >
              <Input
                type="password"
                data-testid="feishu-config-app-secret"
                value={draft.appSecret}
                autoComplete="new-password"
                placeholder={view.hasAppSecret ? "已保存" : "应用密钥"}
                onChange={(event) => setDraft({ ...draft, appSecret: event.target.value })}
              />
            </Field>
          </div>
          <Field
            label="开放平台域名"
            hint="默认 https://open.feishu.cn；国际版 Lark 用 https://open.larksuite.com。"
          >
            <Input
              data-testid="feishu-config-origin"
              value={draft.origin}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setDraft({ ...draft, origin: event.target.value })}
            />
          </Field>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              data-testid="feishu-config-enabled"
              className="mt-1 size-4 accent-primary"
              checked={draft.enabled}
              onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
            />
            <span>
              接收飞书消息
              <span className="mt-1 block text-xs text-muted-foreground">
                保存后立即生效，不需要重启服务。
              </span>
            </span>
          </label>
          {saveError ? <ResultError error={saveError} testId="feishu-config-save-error" /> : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" size="sm" data-testid="feishu-config-save" disabled={pending}>
              {pending ? "保存中…" : "保存配置"}
            </Button>
            {saved ? (
              <span data-testid="feishu-config-saved" className="text-xs text-muted-foreground">
                已保存，立即生效
              </span>
            ) : null}
          </div>
        </form>
      )}
    </SettingsSection>
  );
}
