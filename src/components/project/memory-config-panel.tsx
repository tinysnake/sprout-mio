import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { saveMemoryConfigInput, type MemorySettingsView } from "../../contracts/memory";
import {
  clearMemoryFn,
  getMemoryConfigFn,
  retryMemoryInstallFn,
  saveMemoryConfigFn,
  testMemoryConnectionFn,
} from "../../server/functions/memory";
import { Button } from "../ui/button";
import { Field } from "../ui/field";
import { Input } from "../ui/input";
import {
  memoryActionFailureText,
  memoryBankPreview,
  memoryConfigDraft,
  memoryConfigSaveInput,
  memoryStatus,
  type MemoryConfigDraft,
} from "./memory-config-view";
import { Facts, SettingsSection } from "./settings-section";

type Feedback =
  | { state: "idle" }
  | { state: "pending"; message: string }
  | { state: "success" | "error"; message: string };
type Action = "test" | "retry" | "clear";

function Result({ feedback }: { feedback: Feedback }) {
  return (
    <p
      aria-live="polite"
      className={`text-xs leading-6 [overflow-wrap:anywhere] ${
        feedback.state === "error"
          ? "text-destructive"
          : feedback.state === "success"
            ? "text-status-success"
            : "text-muted-foreground"
      }`}
    >
      {feedback.state === "idle" ? null : feedback.message}
    </p>
  );
}

function Toggle({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 text-xs">
      <span className="min-w-0">
        <span className="font-medium">{label}</span>
        <span className="mt-1.5 block leading-6 text-muted-foreground">{description}</span>
      </span>
      <input
        type="checkbox"
        role="switch"
        className="mt-0.5 size-4 shrink-0 accent-primary"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

function ActionRow({ children, feedback }: { children: ReactNode; feedback: Feedback }) {
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-3">{children}</div>
      <Result feedback={feedback} />
    </div>
  );
}

export function MemoryConfigPanel({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  const [view, setView] = useState<MemorySettingsView | null>(null);
  const [draft, setDraft] = useState<MemoryConfigDraft | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [saveResult, setSaveResult] = useState<Feedback>({ state: "idle" });
  const [actions, setActions] = useState<Record<Action, Feedback>>({
    test: { state: "idle" },
    retry: { state: "idle" },
    clear: { state: "idle" },
  });
  const [confirming, setConfirming] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [pollMessage, setPollMessage] = useState<string | null>(null);
  const [pollAttempt, setPollAttempt] = useState(0);
  const mounted = useRef(false);
  const busy = useRef(false);
  const readVersion = useRef(0);
  const pending =
    saveResult.state === "pending" ||
    Object.values(actions).some((item) => item.state === "pending");
  const installing =
    view?.install?.status === "installing" ||
    (view?.effectiveState.state === "unavailable" && view.effectiveState.reason === "installing");

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    setLoadError(null);
    void (async () => {
      try {
        const result = await getMemoryConfigFn({ data: { projectId } });
        if (!active) return;
        if (!result.ok) {
          setLoadError(result.error.message);
          return;
        }
        setView(result.data);
        setDraft(memoryConfigDraft(result.data));
      } catch {
        if (active) setLoadError("读取失败，请重试");
      }
    })();
    return () => {
      active = false;
    };
  }, [projectId, loadAttempt]);

  useEffect(() => {
    if (!installing) {
      setPollMessage(null);
      return;
    }
    let active = true;
    let ticks = 0;
    let reading = false;
    setPollMessage(null);
    const timer = setInterval(() => {
      ticks++;
      if (ticks <= 30) void poll();
      if (ticks === 30) {
        clearInterval(timer);
        setPollMessage("安装仍在进行，自动刷新已暂停。可手动刷新状态。");
      }
    }, 2_000);
    async function poll() {
      if (reading) return;
      reading = true;
      const version = readVersion.current;
      try {
        if (!busy.current) {
          const result = await getMemoryConfigFn({ data: { projectId } });
          if (!active) return;
          if (version === readVersion.current && !busy.current) {
            if (result.ok) {
              setView(result.data);
              if (ticks < 30) setPollMessage(null);
            } else setPollMessage(`刷新失败。${result.error.message}`);
          }
        }
      } catch {
        if (active) setPollMessage("刷新失败，将继续尝试");
      } finally {
        reading = false;
      }
    }
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [installing, projectId, pollAttempt]);

  async function refreshView(): Promise<string> {
    try {
      const result = await getMemoryConfigFn({ data: { projectId } });
      if (!mounted.current) return "";
      if (!result.ok) return `状态刷新失败。${result.error.message}`;
      setView(result.data);
      return "";
    } catch {
      return "状态刷新失败，请稍后重试";
    }
  }

  function change<K extends keyof MemoryConfigDraft>(key: K, value: MemoryConfigDraft[K]) {
    if (!draft) return;
    setDraft({ ...draft, [key]: value });
    setSaveResult({ state: "idle" });
    setActions({ test: { state: "idle" }, retry: { state: "idle" }, clear: { state: "idle" } });
    if (key === "enabled" && !value) {
      setConfirming(false);
      setConfirmName("");
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!view || !draft || busy.current) return;
    const parsed = saveMemoryConfigInput.safeParse(memoryConfigSaveInput(projectId, draft, view));
    if (!parsed.success) {
      setSaveResult({ state: "error", message: "请检查服务地址与记忆库名称格式" });
      return;
    }
    busy.current = true;
    readVersion.current++;
    setSaveResult({ state: "pending", message: "正在保存配置…" });
    try {
      const result = await saveMemoryConfigFn({ data: parsed.data });
      if (!mounted.current) return;
      if (!result.ok) {
        let message = result.error.message;
        if (result.error.code === "conflict") {
          message = "配置已被其他人修改，请重新保存";
          try {
            message += (await refreshView()) ? "。重新读取失败，请稍后重试" : "";
          } catch {
            message += "。重新读取失败，请稍后重试";
          }
        }
        if (mounted.current) setSaveResult({ state: "error", message });
        return;
      }
      setView(result.data);
      setDraft(memoryConfigDraft(result.data));
      setSaveResult({ state: "success", message: "已保存，后续会话使用新配置" });
      setActions({ test: { state: "idle" }, retry: { state: "idle" }, clear: { state: "idle" } });
      setPollAttempt((value) => value + 1);
    } catch {
      if (mounted.current)
        setSaveResult({ state: "error", message: "保存失败，请重试。草稿已保留。" });
    } finally {
      busy.current = false;
    }
  }

  async function runAction(action: Action) {
    if (busy.current) return;
    busy.current = true;
    readVersion.current++;
    setActions((previous) => ({
      ...previous,
      [action]: { state: "pending", message: "正在处理…" },
    }));
    let feedback: Feedback;
    try {
      if (action === "test") {
        const result = await testMemoryConnectionFn({ data: { projectId } });
        feedback = !result.ok
          ? { state: "error", message: result.error.message }
          : !result.data.ok
            ? { state: "error", message: memoryActionFailureText(result.data) }
            : {
                state: "success",
                message: result.data.created ? "连接成功，记忆库已创建" : "连接成功，记忆库已存在",
              };
      } else if (action === "retry") {
        const result = await retryMemoryInstallFn({ data: { projectId } });
        feedback = result.ok
          ? {
              state: "success",
              message:
                result.data.install?.status === "ready"
                  ? "记忆组件已安装"
                  : "已请求安装，正在刷新状态",
            }
          : { state: "error", message: result.error.message };
        if (result.ok && mounted.current) {
          const warning = await refreshView();
          if (warning) feedback = { state: "error", message: `已请求安装。${warning}` };
          setPollAttempt((value) => value + 1);
        }
      } else {
        const result = await clearMemoryFn({ data: { projectId, confirmName } });
        feedback = !result.ok
          ? { state: "error", message: result.error.message }
          : !result.data.ok
            ? { state: "error", message: memoryActionFailureText(result.data) }
            : { state: "success", message: "本 Project 的记忆已清空" };
        if (result.ok && result.data.ok && mounted.current) {
          setConfirming(false);
          setConfirmName("");
          const warning = await refreshView();
          if (warning) feedback = { state: "error", message: `记忆已清空。${warning}` };
        }
      }
    } catch {
      feedback = { state: "error", message: "请求失败，请重试" };
    } finally {
      busy.current = false;
    }
    if (mounted.current) setActions((previous) => ({ ...previous, [action]: feedback }));
  }

  if (loadError)
    return (
      <SettingsSection title="记忆" testId="memory-config-panel">
        <p role="alert" className="text-xs text-destructive">
          {loadError}
        </p>
        <Button
          type="button"
          variant="secondary"
          className="mt-3"
          onClick={() => setLoadAttempt((value) => value + 1)}
        >
          重新读取
        </Button>
      </SettingsSection>
    );
  if (!view || !draft)
    return (
      <SettingsSection title="记忆" testId="memory-config-panel">
        <p role="status" className="text-sm text-muted-foreground">
          正在读取记忆配置…
        </p>
      </SettingsSection>
    );

  const status = memoryStatus(view.effectiveState);
  const preview = memoryBankPreview(draft, projectId);
  const dirty =
    JSON.stringify(memoryConfigSaveInput(projectId, draft, view)) !==
    JSON.stringify(memoryConfigSaveInput(projectId, memoryConfigDraft(view), view));
  const installLabel = view.install
    ? { missing: "未安装", installing: "安装中", ready: "已安装", failed: "安装失败" }[
        view.install.status
      ]
    : "未安装";

  return (
    <form onSubmit={save} className="min-w-0" data-testid="memory-config-panel">
      <SettingsSection
        title="启用记忆"
        divided={false}
        actions={
          <span
            data-testid="memory-config-status"
            className={`rounded-full border border-border px-2 py-0.5 text-xs ${status.className}`}
          >
            {status.label}
          </span>
        }
      >
        <Toggle
          label="启用记忆"
          description={
            draft.enabled
              ? "让本 Project 的 Agent 读写记忆库。"
              : "开启后可配置记忆库、自动维护与连接。"
          }
          checked={draft.enabled}
          disabled={pending}
          onChange={(value) => change("enabled", value)}
        />
      </SettingsSection>
      {draft.enabled && (
        <>
          <SettingsSection title="记忆库" description="修改后新记忆写入新库，旧内容不会迁移。">
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-start gap-2">
              <Field label="记忆库前缀" hint="小写字母、数字、下划线或短横线。">
                <Input
                  value={draft.bankPrefix}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={pending}
                  onChange={(event) => change("bankPrefix", event.target.value)}
                />
              </Field>
              <span aria-hidden="true" className="pt-7 font-mono text-muted-foreground">
                ::
              </span>
              <Field label="记忆库名称" hint="留空使用 Project ID。">
                <Input
                  value={draft.bankName}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={pending}
                  onChange={(event) => change("bankName", event.target.value)}
                />
              </Field>
            </div>
            <p
              aria-live="polite"
              className={`mt-3 text-xs leading-6 [overflow-wrap:anywhere] ${preview.error ? "text-destructive" : "text-muted-foreground"}`}
            >
              {preview.error ?? (
                <>
                  实际使用 <span className="font-mono text-foreground">{preview.bank}</span>
                </>
              )}
            </p>
          </SettingsSection>
          <SettingsSection title="自动维护">
            <div className="space-y-5">
              <Toggle
                label="入库时自动索引新提交"
                description="让记忆知道代码已经变了。"
                checked={draft.autoIndexCommits}
                disabled={pending}
                onChange={(value) => change("autoIndexCommits", value)}
              />
              <Toggle
                label="整理页面"
                description="定期把零散记录整理成页面，按运行次数触发。"
                checked={draft.refreshPages}
                disabled={pending}
                onChange={(value) => change("refreshPages", value)}
              />
            </div>
          </SettingsSection>
          <SettingsSection title="连接">
            <div className="space-y-4">
              <Field label="服务地址" hint="留空使用服务端默认地址。自建或云端服务填完整地址。">
                <Input
                  placeholder="http://127.0.0.1:8888"
                  value={draft.apiUrl}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={pending}
                  onChange={(event) => change("apiUrl", event.target.value)}
                />
              </Field>
              <Field label="连接密钥" hint="密钥只写不读，保存后不再显示。">
                <Input
                  type="password"
                  placeholder={view.config?.hasToken ? "已保存，留空保持不变" : "连接密钥"}
                  autoComplete="new-password"
                  value={draft.apiToken}
                  disabled={pending}
                  onChange={(event) => change("apiToken", event.target.value)}
                />
              </Field>
            </div>
          </SettingsSection>
          <SettingsSection
            title="操作"
            description="操作使用已保存的配置。测试连接会检查记忆库，不存在时创建。"
          >
            <div className="space-y-4">
              <Facts
                items={[
                  {
                    label: "已保存的库",
                    value: <span className="font-mono">{view.bankPreview.bankId}</span>,
                  },
                  {
                    label: "记忆组件",
                    value: `${installLabel} · ${view.install?.version ?? view.extensionVersion}`,
                  },
                  { label: "Machine", value: view.machineId ?? "未绑定" },
                ]}
              />
              {view.message && (
                <p className="text-xs leading-6 text-muted-foreground [overflow-wrap:anywhere]">
                  {view.message}
                </p>
              )}
              {view.install?.error && (
                <p className="text-xs leading-6 text-destructive [overflow-wrap:anywhere]">
                  {view.install.error}
                </p>
              )}
              <div aria-live="polite" className="text-xs leading-6 text-muted-foreground">
                {pollMessage}
                {pollMessage && (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="ml-2"
                    disabled={pending}
                    onClick={() => setPollAttempt((value) => value + 1)}
                  >
                    刷新状态
                  </Button>
                )}
              </div>
              {dirty && <p className="text-xs text-muted-foreground">请先保存配置，再执行操作。</p>}
              <ActionRow feedback={actions.test}>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={pending || dirty}
                  loading={actions.test.state === "pending"}
                  onClick={() => void runAction("test")}
                >
                  测试连接
                </Button>
              </ActionRow>
              <ActionRow feedback={actions.retry}>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={pending || dirty || installing}
                  loading={actions.retry.state === "pending"}
                  onClick={() => void runAction("retry")}
                >
                  重试安装
                </Button>
              </ActionRow>
              <ActionRow feedback={actions.clear}>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={pending || dirty}
                  aria-expanded={confirming}
                  onClick={() => {
                    setConfirming((value) => !value);
                    setConfirmName("");
                  }}
                >
                  清空记忆
                </Button>
              </ActionRow>
              {confirming && (
                <div className="space-y-3 border-l-2 border-destructive pl-4">
                  <Field
                    label="输入 Project 名确认清空"
                    hint={
                      <>
                        请输入{" "}
                        <span className="font-medium [overflow-wrap:anywhere]">{projectName}</span>
                        。清空后无法恢复。
                      </>
                    }
                  >
                    <Input
                      value={confirmName}
                      autoComplete="off"
                      disabled={pending}
                      onChange={(event) => setConfirmName(event.target.value)}
                    />
                  </Field>
                  <div className="flex flex-wrap gap-3">
                    <Button
                      type="button"
                      variant="destructive"
                      disabled={pending || dirty || confirmName !== projectName}
                      loading={actions.clear.state === "pending"}
                      onClick={() => void runAction("clear")}
                    >
                      确认清空记忆
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={pending}
                      onClick={() => {
                        setConfirming(false);
                        setConfirmName("");
                      }}
                    >
                      取消
                    </Button>
                  </div>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-3">
                <Button type="button" variant="secondary" disabled>
                  从仓库历史导入
                </Button>
                <span className="text-xs text-muted-foreground">未实现，P4</span>
              </div>
            </div>
          </SettingsSection>
        </>
      )}
      <div className="space-y-3 border-t border-border py-5">
        <Result feedback={saveResult} />
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="submit"
            loading={saveResult.state === "pending"}
            disabled={pending || Boolean(preview.error)}
          >
            保存
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={pending}
            onClick={() => {
              setDraft(memoryConfigDraft(view));
              setSaveResult({ state: "idle" });
              setConfirming(false);
              setConfirmName("");
            }}
          >
            取消
          </Button>
        </div>
      </div>
    </form>
  );
}
