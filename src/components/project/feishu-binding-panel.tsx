import { useEffect, useState } from "react";
import type {
  FeishuBindingView,
  FeishuChallengeView,
  FeishuTargetOption,
} from "../../contracts/feishu-channel";
import { ID_PREFIXES, newId } from "../../contracts/ids";
import type { AppError, AppResult } from "../../contracts/result";
import { toAppError } from "../../contracts/result";
import {
  finishFeishuBindingFn,
  getFeishuBindingFn,
  listFeishuTargetsFn,
  startFeishuChallengeFn,
  switchFeishuTargetFn,
  unbindFeishuBindingFn,
} from "../../server/functions/feishu";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Field } from "../ui/field";
import { Select } from "../ui/select";
import {
  FEISHU_UNCONFIGURED_COPY,
  challengeRemainingLabel,
  connectionPhaseLabel,
  feishuFailureText,
  targetLabel,
  targetOptionLabel,
} from "./feishu-binding-copy";
import { ResultError } from "./result-error";
import { Facts, SettingsSection } from "./settings-section";

const DESCRIPTION =
  "绑定你的飞书账号，并选择接收指令的助理私聊。仅私聊，不接收群消息，也不向群发送。";

type Challenge = { code: string; expiresAtMs: number };
type Action = "start" | "finish" | "switch" | "unbind";

function translated(error: AppError): AppError {
  return { ...error, message: feishuFailureText(error) };
}

function StatusChip({ children }: { children: string }) {
  return (
    <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
      {children}
    </span>
  );
}

function TargetSelect({
  label,
  testId,
  targets,
  value,
  onChange,
  disabled,
}: {
  label: string;
  testId: string;
  targets: FeishuTargetOption[];
  value: string;
  onChange: (chatId: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="max-w-md">
      <Field label={label} hint="只列出这个 Project 里由你拥有的助理私聊。">
        <Select
          data-testid={testId}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
        >
          <option value="">选择助理私聊</option>
          {targets.map((target) => (
            <option key={target.chatId} value={target.chatId}>
              {targetOptionLabel(target)}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );
}

export function FeishuBindingPanel({
  projectId,
  clock = Date.now,
}: {
  projectId: string;
  clock?: () => number;
}) {
  const [view, setView] = useState<FeishuBindingView | null>(null);
  const [targets, setTargets] = useState<FeishuTargetOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<AppError | null>(null);
  const [targetsError, setTargetsError] = useState<AppError | null>(null);
  const [selectedChatId, setSelectedChatId] = useState("");
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [expired, setExpired] = useState(false);
  const [mode, setMode] = useState<"idle" | "switch">("idle");
  const [pending, setPending] = useState<Action | null>(null);
  const [actionError, setActionError] = useState<AppError | null>(null);
  const [unbindOpen, setUnbindOpen] = useState(false);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setLoadError(null);
    setTargetsError(null);
    void Promise.all([
      getFeishuBindingFn({ data: { projectId } }),
      listFeishuTargetsFn({ data: { projectId } }),
    ])
      .then(([binding, list]) => {
        if (!live) return;
        if (binding.ok) setView(binding.data);
        else setLoadError(binding.error);
        if (list.ok) {
          setTargets(list.data.targets);
          setSelectedChatId("");
        } else {
          setTargetsError(list.error);
        }
      })
      .catch((cause) => {
        if (live) setLoadError(toAppError(cause, newId(ID_PREFIXES.request)));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [projectId]);

  const expiresAtMs = (challenge ?? view?.challenge)?.expiresAtMs ?? null;
  const [now, setNow] = useState(clock);

  useEffect(() => {
    if (expiresAtMs === null) {
      setExpired(false);
      return;
    }
    setNow(clock());
    setExpired(clock() >= expiresAtMs);
    const timer = setInterval(() => setNow(clock()), 30_000);
    return () => clearInterval(timer);
  }, [expiresAtMs, clock]);

  useEffect(() => {
    if (expiresAtMs === null) return;
    const timer = setTimeout(
      () => {
        setExpired(true);
        void refreshBinding();
      },
      Math.max(0, expiresAtMs - now),
    );
    return () => clearTimeout(timer);
  }, [expiresAtMs, now]);

  async function refreshBinding() {
    try {
      const result = await getFeishuBindingFn({ data: { projectId } });
      if (!result.ok) {
        setActionError(result.error);
        return;
      }
      setView(result.data);
      if (result.data.binding.bound) setChallenge(null);
    } catch (cause) {
      setActionError(toAppError(cause, newId(ID_PREFIXES.request)));
    }
  }

  async function runAction<T>(
    action: Action,
    request: () => Promise<AppResult<T>>,
    apply: (data: T) => void,
  ) {
    setPending(action);
    setActionError(null);
    try {
      const result = await request();
      if (!result.ok) {
        setActionError(result.error);
        if (result.error.code === "conflict") await refreshBinding();
        return;
      }
      apply(result.data);
      await refreshBinding();
    } catch (cause) {
      setActionError(toAppError(cause, newId(ID_PREFIXES.request)));
    } finally {
      setPending(null);
    }
  }

  function startBinding(chatId: string) {
    if (!view) return;
    setSelectedChatId(chatId);
    void runAction(
      "start",
      () =>
        startFeishuChallengeFn({
          data: { projectId, chatId, expectedRevision: view.binding.revision },
        }),
      (data: FeishuChallengeView) => {
        setChallenge({ code: data.challenge, expiresAtMs: data.expiresAtMs });
        setView(data.binding);
      },
    );
  }

  async function confirmBinding() {
    setPending("finish");
    setActionError(null);
    try {
      // 飞书私聊里的确认会把 revision 再推进一次，本地记下的 revision 已经过期，
      // 所以先读最新状态：已绑定就直接收尾，否则用新 revision 拿服务端的中文提示。
      const current = await getFeishuBindingFn({ data: { projectId } });
      if (!current.ok) {
        setActionError(current.error);
        return;
      }
      setView(current.data);
      if (current.data.binding.bound) {
        setChallenge(null);
        return;
      }
      const confirmed = await finishFeishuBindingFn({
        data: { projectId, expectedRevision: current.data.binding.revision },
      });
      if (!confirmed.ok) {
        setActionError(confirmed.error);
        if (confirmed.error.code === "conflict") await refreshBinding();
        return;
      }
      setView(confirmed.data);
      setChallenge(null);
    } catch (cause) {
      setActionError(toAppError(cause, newId(ID_PREFIXES.request)));
    } finally {
      setPending(null);
    }
  }

  function switchTarget(chatId: string) {
    if (!view) return;
    void runAction(
      "switch",
      () =>
        switchFeishuTargetFn({
          data: { projectId, chatId, expectedRevision: view.binding.revision },
        }),
      (data: FeishuBindingView) => {
        setView(data);
        setMode("idle");
      },
    );
  }

  function unbind() {
    if (!view) return;
    void runAction(
      "unbind",
      () => unbindFeishuBindingFn({ data: { projectId, expectedRevision: view.binding.revision } }),
      (data: FeishuBindingView) => {
        setView(data);
        setChallenge(null);
        setUnbindOpen(false);
        setMode("idle");
      },
    );
  }

  if (loading) {
    return (
      <SettingsSection title="飞书接入" description={DESCRIPTION} testId="feishu-binding-panel">
        <p className="text-sm text-muted-foreground">正在读取飞书绑定状态…</p>
      </SettingsSection>
    );
  }

  if (!view) {
    return (
      <SettingsSection title="飞书接入" description={DESCRIPTION} testId="feishu-binding-panel">
        {loadError ? (
          <ResultError error={translated(loadError)} testId="feishu-load-error" />
        ) : (
          <p className="text-sm text-muted-foreground">正在读取飞书绑定状态…</p>
        )}
      </SettingsSection>
    );
  }

  if (!view.configured) {
    return (
      <SettingsSection
        title="飞书接入"
        description={DESCRIPTION}
        actions={<StatusChip>未配置</StatusChip>}
        testId="feishu-binding-panel"
      >
        <p className="text-sm">{FEISHU_UNCONFIGURED_COPY}</p>
      </SettingsSection>
    );
  }

  const binding = view.binding;
  const active = challenge ?? view.challenge;
  const bound = binding.bound;

  if (bound && mode === "switch") {
    const currentChatId = binding.target?.chatId ?? "";
    return (
      <SettingsSection
        title="飞书接入"
        description="换绑只改动你自己的绑定，不影响其他 Human 的绑定。"
        testId="feishu-binding-panel"
      >
        <Facts
          items={[
            {
              label: "当前目标",
              testId: "feishu-switch-current",
              value: binding.target ? targetLabel(binding.target) : "绑定在其他 Project",
            },
          ]}
        />
        {targetsError ? (
          <div className="mt-4">
            <ResultError error={translated(targetsError)} testId="feishu-targets-error" />
          </div>
        ) : targets.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">
            当前 Project 没有可换绑的助理私聊，请先在 Project 里创建助理。
          </p>
        ) : (
          <div className="mt-4">
            <TargetSelect
              label="新目标"
              testId="feishu-switch-select"
              targets={targets}
              value={selectedChatId}
              onChange={(chatId) => {
                setSelectedChatId(chatId);
                setActionError(null);
              }}
              disabled={pending !== null}
            />
          </div>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            data-testid="feishu-switch-submit"
            onClick={() => switchTarget(selectedChatId)}
            disabled={pending !== null || selectedChatId === "" || selectedChatId === currentChatId}
          >
            {pending === "switch" ? "换绑中…" : "确认换绑"}
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setMode("idle");
              setActionError(null);
            }}
            disabled={pending !== null}
          >
            取消
          </Button>
        </div>
        {actionError && (
          <div className="mt-4">
            <ResultError error={translated(actionError)} testId="feishu-action-error" />
          </div>
        )}
      </SettingsSection>
    );
  }

  if (bound) {
    return (
      <SettingsSection
        title="飞书接入"
        description={DESCRIPTION}
        actions={<StatusChip>已绑定</StatusChip>}
        testId="feishu-binding-panel"
      >
        <Facts
          items={[
            {
              label: "助理",
              testId: "feishu-bound-agent",
              value: binding.target?.agentName ?? "绑定在其他 Project 的助理",
            },
            {
              label: "会话",
              testId: "feishu-bound-chat",
              value: binding.target
                ? (binding.target.chatTitle ?? "未命名私聊")
                : "当前 Project 不可见",
            },
            {
              label: "连接状态",
              testId: "feishu-connection-phase",
              value: connectionPhaseLabel(view.connection.phase),
            },
          ]}
        />
        <div className="mt-5 flex flex-wrap gap-2">
          <Button
            variant="secondary"
            data-testid="feishu-switch-action"
            onClick={() => {
              setActionError(null);
              setSelectedChatId(
                targets.find((target) => target.chatId !== binding.target?.chatId)?.chatId ?? "",
              );
              setMode("switch");
            }}
            disabled={pending !== null}
          >
            换绑
          </Button>
          <Button
            variant="destructive"
            data-testid="feishu-unbind-action"
            onClick={() => {
              setActionError(null);
              setUnbindOpen(true);
            }}
            disabled={pending !== null}
          >
            解绑
          </Button>
        </div>
        {actionError && !unbindOpen && (
          <div className="mt-4">
            <ResultError error={translated(actionError)} testId="feishu-action-error" />
          </div>
        )}
        <Dialog
          open={unbindOpen}
          onOpenChange={(open) => {
            if (!pending) setUnbindOpen(open);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>解绑飞书私聊</DialogTitle>
              <DialogDescription>
                解绑后不再通过飞书收发消息；助理会话与历史记录保留，可以稍后重新绑定。
              </DialogDescription>
            </DialogHeader>
            {actionError && (
              <ResultError error={translated(actionError)} testId="feishu-unbind-error" />
            )}
            <DialogFooter>
              <DialogClose render={<Button variant="secondary" />}>取消</DialogClose>
              <Button
                variant="destructive"
                data-testid="feishu-unbind-confirm"
                onClick={unbind}
                disabled={pending !== null}
              >
                {pending === "unbind" ? "解绑中…" : "确认解绑"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </SettingsSection>
    );
  }

  if (active) {
    const code = challenge?.code ?? null;
    const target = targets.find((option) => option.chatId === selectedChatId);
    const restartChatId = selectedChatId;
    return (
      <SettingsSection
        title="飞书接入"
        description={DESCRIPTION}
        actions={<StatusChip>{expired ? "确认码已过期" : "等待飞书确认"}</StatusChip>}
        testId="feishu-binding-panel"
      >
        {expired ? (
          <>
            <p className="text-sm">确认码已过期，需要重新发起绑定。</p>
            <p className="mt-2 text-xs leading-6 text-muted-foreground">
              重新发起会生成新的确认码，旧确认码随即作废。
            </p>
          </>
        ) : code ? (
          <>
            <p className="text-sm">在飞书里给这个机器人发这个码：</p>
            <p
              data-testid="feishu-challenge-code"
              className="mt-3 font-mono text-2xl tracking-[0.2em]"
            >
              {code}
            </p>
            <p className="mt-3 text-xs leading-6 text-muted-foreground">
              {challengeRemainingLabel(active.expiresAtMs, now)}
              {target && ` · 目标：${targetOptionLabel(target)}`}
            </p>
          </>
        ) : (
          <>
            <p className="text-sm">已发起绑定，正在等待你在飞书里确认。</p>
            <p className="mt-2 text-xs leading-6 text-muted-foreground">
              确认码只在发起时显示一次，如果没有记下，请重新发起。
            </p>
            <p className="mt-2 text-xs leading-6 text-muted-foreground">
              {challengeRemainingLabel(active.expiresAtMs, now)}
            </p>
          </>
        )}
        {(expired || challenge === null) && targets.length > 0 && (
          <div className="mt-4">
            <TargetSelect
              label="重新发起的对象"
              testId="feishu-restart-select"
              targets={targets}
              value={selectedChatId}
              onChange={(chatId) => {
                setSelectedChatId(chatId);
                setActionError(null);
              }}
              disabled={pending !== null}
            />
          </div>
        )}
        <div className="mt-5 flex flex-wrap gap-2">
          {!expired && (
            <Button
              data-testid="feishu-finish-action"
              onClick={confirmBinding}
              disabled={pending !== null}
            >
              {pending === "finish" ? "确认中…" : "我已在飞书确认"}
            </Button>
          )}
          <Button
            variant={expired ? "default" : "secondary"}
            data-testid="feishu-restart-action"
            onClick={() => {
              if (restartChatId) startBinding(restartChatId);
            }}
            disabled={pending !== null || restartChatId === ""}
          >
            {pending === "start" ? "发起中…" : "重新发起"}
          </Button>
        </div>
        {targetsError && (
          <div className="mt-4">
            <ResultError error={translated(targetsError)} testId="feishu-targets-error" />
          </div>
        )}
        {actionError && (
          <div className="mt-4">
            <ResultError error={translated(actionError)} testId="feishu-action-error" />
          </div>
        )}
      </SettingsSection>
    );
  }

  return (
    <SettingsSection
      title="飞书接入"
      description={DESCRIPTION}
      actions={<StatusChip>未绑定</StatusChip>}
      testId="feishu-binding-panel"
    >
      <p className="text-sm">
        还没有绑定飞书账号。绑定由 Sprout 发起，再到飞书里确认；确认前不会通过飞书收发消息。
      </p>
      {targetsError ? (
        <div className="mt-4">
          <ResultError error={translated(targetsError)} testId="feishu-targets-error" />
        </div>
      ) : targets.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">
          当前 Project 没有可绑定的助理私聊，请先在 Project 里创建助理。
        </p>
      ) : (
        <div className="mt-4">
          <TargetSelect
            label="绑定目标"
            testId="feishu-target-select"
            targets={targets}
            value={selectedChatId}
            onChange={(chatId) => {
              setSelectedChatId(chatId);
              setActionError(null);
            }}
            disabled={pending !== null}
          />
        </div>
      )}
      <div className="mt-4">
        <Button
          data-testid="feishu-start-action"
          onClick={() => startBinding(selectedChatId)}
          disabled={pending !== null || selectedChatId === ""}
        >
          {pending === "start" ? "发起中…" : "发起绑定"}
        </Button>
      </div>
      {actionError && (
        <div className="mt-4">
          <ResultError error={translated(actionError)} testId="feishu-action-error" />
        </div>
      )}
    </SettingsSection>
  );
}
