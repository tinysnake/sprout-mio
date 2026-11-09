import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Popover } from "@base-ui/react/popover";
import { ChevronRight, CircleHelp } from "lucide-react";
import type { AgentProfile, ProjectMember } from "../../contracts/agent";
import type {
  AutomationAction,
  AutomationHistory,
  CronRule,
  CronTrigger,
  WebhookRule,
} from "../../contracts/automation";
import type { Chat } from "../../contracts/chat";
import { listAgentProfilesFn, listProjectMembersFn } from "../../server/functions/agent";
import { listChatMembersFn, listChatsFn } from "../../server/functions/chat";
import {
  createCronRuleFn,
  createWebhookRuleFn,
  cronHistoryFn,
  listCronRulesFn,
  listWebhookRulesFn,
  rotateWebhookSecretFn,
  trialCronFn,
  trialWebhookFn,
  updateCronRuleFn,
  updateWebhookRuleFn,
  webhookHistoryFn,
  webhookSecretFn,
} from "../../server/functions/automation";
import { PageFrame } from "../layout/page-frame";
import { PageBackLink } from "../layout/page-back";
import { Button, buttonVariants } from "../ui/button";
import { Icon } from "../ui/icon";
import { SettingsSection } from "./settings-section";

type Kind = "webhooks" | "cron";
type Rule = WebhookRule | CronRule;
type History = AutomationHistory | AutomationHistory<CronTrigger>;
const titles = { webhooks: "Webhook", cron: "定时规则" };
const field =
  "block w-full min-w-0 max-w-full rounded-control border border-input bg-background px-3 py-2 text-sm";
const initial = {
  name: "",
  instruction: "",
  enabled: false,
  expression: "0 9 * * *",
  timezone: "UTC",
  kind: "dm_agent",
  chatId: "",
  agentProfileId: "",
};
type Draft = typeof initial;
function edit(rule: Rule): Draft {
  return {
    ...initial,
    name: rule.name,
    instruction: rule.instruction,
    enabled: rule.enabled,
    expression: "expression" in rule ? rule.expression : initial.expression,
    timezone: "timezone" in rule ? rule.timezone : initial.timezone,
    kind: rule.action.kind,
    chatId: rule.action.chatId ?? "",
    agentProfileId: "agentProfileId" in rule.action ? rule.action.agentProfileId : "",
  };
}
const listRules = (kind: Kind, projectId: string) =>
  kind === "cron"
    ? listCronRulesFn({ data: { projectId } })
    : listWebhookRulesFn({ data: { projectId } });
function actionLabel(action: AutomationAction, agents: AgentProfile[], chats: Chat[]) {
  const agent =
    "agentProfileId" in action
      ? (agents.find((a) => a.id === action.agentProfileId)?.name ?? action.agentProfileId)
      : "当前 Agent owner";
  if (action.kind === "dm_agent") return `DM → ${agent}`;
  const chat = chats.find((c) => c.id === action.chatId);
  return `${chat?.kind === "public_channel" ? "公共频道" : "Group"} · ${chat?.title || action.chatId} → ${agent}`;
}
function nextTime(rule: CronRule) {
  if (!rule.nextAt) return "停用，无下次时间";
  return `${new Date(rule.nextAt).toLocaleString("zh-CN", { timeZone: rule.timezone })}（${rule.timezone}）`;
}
export function AutomationSettings({ projectId, kind }: { projectId: string; kind: Kind }) {
  const [rules, setRules] = useState<Rule[]>([]);
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [chats, setChats] = useState<Chat[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    void Promise.all([
      listRules(kind, projectId),
      listAgentProfilesFn(),
      listChatsFn({ data: { projectId } }),
    ])
      .then(([r, a, c]) => {
        if (!live) return;
        if (!r.ok || !a.ok || !c.ok) {
          setError("自动化规则读取失败，请刷新页面重试。");
          return;
        }
        setRules(r.data);
        setAgents(a.data);
        setChats(c.data);
      })
      .catch(() => {
        if (live) setError("自动化规则读取失败，请刷新页面重试。");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [projectId, kind]);
  const newRoute =
    kind === "cron"
      ? "/projects/$projectId/settings/cron/new"
      : "/projects/$projectId/settings/webhooks/new";
  return (
    <SettingsSection
      divided={false}
      title={kind === "cron" ? "定时任务" : "Webhooks"}
      description={
        kind === "cron"
          ? "按指定时区与 cron 表达式向 Project 的 Agent 发送指令。"
          : "由可信来源的 HTTP 请求触发 Project 中的工作。"
      }
    >
      <div
        className="mb-4 flex flex-wrap items-center justify-between gap-3"
        data-testid="automation-list-toolbar"
      >
        <p className="text-sm text-muted-foreground">
          {loading ? "读取中…" : `${rules.length} 条规则`}
        </p>
        <Link
          to={newRoute}
          params={{ projectId }}
          search={{ tab: kind }}
          className={buttonVariants()}
        >
          新建{titles[kind]}
        </Link>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!loading && !error && rules.length === 0 && (
        <p className="text-sm text-muted-foreground">还没有{titles[kind]}，先创建一条规则。</p>
      )}
      {rules.length > 0 && (
        <ul
          data-testid={`${kind}-list`}
          className="divide-y divide-border overflow-hidden rounded-container border border-border"
        >
          {rules.map((rule) => (
            <li key={rule.id} data-rule-id={rule.id}>
              <Link
                to={
                  kind === "cron"
                    ? "/projects/$projectId/settings/cron/$ruleId"
                    : "/projects/$projectId/settings/webhooks/$ruleId"
                }
                params={{ projectId, ruleId: rule.id }}
                className="flex min-h-22 items-center gap-3.5 px-5 py-5 hover:bg-hover max-desktop:gap-2.5 max-desktop:px-3 max-desktop:py-4"
              >
                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-secondary text-xs font-medium">
                  {kind === "cron" ? "C" : "W"}
                </span>
                <span className="min-w-0 flex-1 break-words">
                  <span className="flex flex-wrap items-baseline gap-x-3">
                    <span className="text-sm font-medium">{rule.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {rule.enabled ? "启用" : "停用"}
                    </span>
                  </span>
                  <span className="mt-1.5 block text-xs leading-6 text-muted-foreground">
                    {actionLabel(rule.action, agents, chats)}
                  </span>
                  {"expression" in rule && (
                    <span className="block text-xs leading-6 text-muted-foreground">
                      {rule.expression} · {rule.timezone} · 下次：{nextTime(rule)}
                    </span>
                  )}
                </span>
                <Icon as={ChevronRight} className="shrink-0 text-muted-foreground" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </SettingsSection>
  );
}

const namedZones = [
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Dubai",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Australia/Sydney",
  "Pacific/Auckland",
];
const offsetZones = Array.from({ length: 27 }, (_, i) => i - 12).map((offset) => ({
  value: offset === 0 ? "UTC" : `Etc/GMT${offset > 0 ? "-" : "+"}${Math.abs(offset)}`,
  label: offset === 0 ? "UTC" : `UTC${offset > 0 ? "+" : "−"}${Math.abs(offset)}`,
}));
export function AutomationEditor({
  projectId,
  kind,
  ruleId,
}: {
  projectId: string;
  kind: Kind;
  ruleId?: string;
}) {
  return (
    <Editor
      key={`${projectId}:${kind}:${ruleId ?? "new"}`}
      projectId={projectId}
      kind={kind}
      ruleId={ruleId}
    />
  );
}
function Editor({ projectId, kind, ruleId }: { projectId: string; kind: Kind; ruleId?: string }) {
  const navigate = useNavigate();
  const [selected, setSelected] = useState<Rule | null>(null);
  const [bootSucceeded, setBootSucceeded] = useState(false);
  const [draft, setDraft] = useState<Draft>(initial);
  const [chats, setChats] = useState<Chat[]>([]);
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [chatAgentIds, setChatAgentIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [history, setHistory] = useState<History[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [secretLoading, setSecretLoading] = useState(false);
  const [secretError, setSecretError] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [payload, setPayload] = useState('{"message":"hello"}');
  const alive = useRef(true);
  const historyVersion = useRef(0);
  const secretVersion = useRef(0);
  useEffect(() => {
    alive.current = true;
    void Promise.all([
      listRules(kind, projectId),
      listChatsFn({ data: { projectId } }),
      listAgentProfilesFn(),
      listProjectMembersFn({ data: { projectId } }),
    ])
      .then(([r, c, a, m]) => {
        if (!alive.current) return;
        if (!r.ok || !c.ok || !a.ok || !m.ok) {
          setError("规则或目标读取失败，请刷新页面重试。");
          return;
        }
        setChats(c.data);
        setAgents(a.data);
        setMembers(m.data);
        if (ruleId) {
          const rule = r.data.find((row) => row.id === ruleId);
          if (!rule) {
            setError("该规则不存在，或不属于当前 Project。请返回规则列表。");
            return;
          }
          setSelected(rule);
          setDraft(edit(rule));
        }
        setBootSucceeded(true);
      })
      .catch(() => {
        if (alive.current) setError("规则读取失败，请刷新页面重试。");
      })
      .finally(() => {
        if (alive.current) setLoading(false);
      });
    return () => {
      alive.current = false;
      historyVersion.current++;
      secretVersion.current++;
    };
  }, [projectId, kind, ruleId]);
  useEffect(() => {
    let live = true;
    setChatAgentIds([]);
    if (draft.kind !== "dm_agent" && draft.chatId)
      void listChatMembersFn({ data: { chatId: draft.chatId } })
        .then((r) => {
          if (!live) return;
          if (r.ok)
            setChatAgentIds(r.data.filter((m) => m.memberKind === "agent").map((m) => m.memberId));
          else setError(r.error.message);
        })
        .catch(() => {
          if (live) setError("Group 成员读取失败，请重新选择目标。");
        });
    return () => {
      live = false;
    };
  }, [draft.kind, draft.chatId]);
  async function readHistory(id: string) {
    const version = ++historyVersion.current;
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const [result, latest] = await Promise.all([
        kind === "cron"
          ? cronHistoryFn({ data: { ruleId: id } })
          : webhookHistoryFn({ data: { ruleId: id } }),
        listRules(kind, projectId),
      ]);
      if (!alive.current || version !== historyVersion.current) return;
      if (result.ok) setHistory(result.data);
      else setHistoryError(result.error.message);
      if (latest.ok) {
        const fresh = latest.data.find((rule) => rule.id === id);
        if (fresh && "nextAt" in fresh)
          setSelected((current) =>
            current?.id === fresh.id && current.revision === fresh.revision ? fresh : current,
          );
      }
    } catch {
      if (alive.current && version === historyVersion.current)
        setHistoryError("触发记录读取失败，请重试。");
    } finally {
      if (alive.current && version === historyVersion.current) setHistoryLoading(false);
    }
  }
  async function readSecret(id: string) {
    const version = ++secretVersion.current;
    setSecretLoading(true);
    setSecretError("");
    setRevealed(false);
    try {
      const result = await webhookSecretFn({ data: { ruleId: id } });
      if (!alive.current || version !== secretVersion.current) return;
      if (result.ok) setSecret(result.data.secret);
      else setSecretError(result.error.message);
    } catch {
      if (alive.current && version === secretVersion.current)
        setSecretError("Secret 读取失败，请重试。");
    } finally {
      if (alive.current && version === secretVersion.current) setSecretLoading(false);
    }
  }
  useEffect(() => {
    if (!selected) return;
    void readHistory(selected.id);
    if (kind === "webhooks") void readSecret(selected.id);
  }, [selected?.id]);
  const eligible = agents.filter(
    (a) =>
      a.purpose === "worker" &&
      members.some((m) => m.agentProfileId === a.id) &&
      (draft.kind === "dm_agent" || chatAgentIds.includes(a.id)),
  );
  const dirty = JSON.stringify(draft) !== JSON.stringify(selected ? edit(selected) : initial);
  const ready = bootSucceeded && !loading && (!ruleId || selected !== null);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!ready || pending || uncertain) return;
    setPending(true);
    setError("");
    setNotice("");
    const action: AutomationAction =
      draft.kind === "dm_agent"
        ? { kind: "dm_agent", agentProfileId: draft.agentProfileId }
        : draft.kind === "group_owner"
          ? { kind: "group_owner", chatId: draft.chatId }
          : { kind: "group_agent", chatId: draft.chatId, agentProfileId: draft.agentProfileId };
    const data = {
      projectId,
      name: draft.name,
      instruction: draft.instruction,
      enabled: draft.enabled,
      action,
    };
    try {
      const result =
        kind === "cron"
          ? selected
            ? await updateCronRuleFn({
                data: {
                  ...data,
                  expression: draft.expression,
                  timezone: draft.timezone,
                  ruleId: selected.id,
                  expectedRevision: selected.revision,
                },
              })
            : await createCronRuleFn({
                data: { ...data, expression: draft.expression, timezone: draft.timezone },
              })
          : selected
            ? await updateWebhookRuleFn({
                data: { ...data, ruleId: selected.id, expectedRevision: selected.revision },
              })
            : await createWebhookRuleFn({ data });
      if (!alive.current) return;
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      const saved = "rule" in result.data ? result.data.rule : result.data;
      if (!ruleId) {
        await navigate({
          to:
            kind === "cron"
              ? "/projects/$projectId/settings/cron/$ruleId"
              : "/projects/$projectId/settings/webhooks/$ruleId",
          params: { projectId, ruleId: saved.id },
          replace: true,
        });
        return;
      }
      setSelected(saved);
      setDraft(edit(saved));
      setNotice("已保存。");
      await readHistory(saved.id);
    } catch {
      if (alive.current) {
        setUncertain(true);
        setError("保存结果未知，可能已提交。请刷新页面核对，不要直接重试。");
      }
    } finally {
      if (alive.current) setPending(false);
    }
  }
  async function trial() {
    if (!selected || pending || dirty || uncertain) return;
    let json: Record<string, unknown> = {};
    if (kind === "webhooks") {
      try {
        const parsed: unknown = JSON.parse(payload);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
        json = parsed as Record<string, unknown>;
      } catch {
        setError("样例必须是有效的 JSON object。");
        return;
      }
    }
    setPending(true);
    setError("");
    setNotice("");
    try {
      const result =
        kind === "cron"
          ? await trialCronFn({ data: { ruleId: selected.id, eventId: crypto.randomUUID() } })
          : await trialWebhookFn({
              data: { ruleId: selected.id, eventId: crypto.randomUUID(), payload: json },
            });
      if (!alive.current) return;
      if (!result.ok) setError(result.error.message);
      else
        setNotice(
          `Trial：${result.data.decision}${result.data.decision === "skipped" ? ` · ${result.data.reason}` : ""}`,
        );
      await readHistory(selected.id);
    } catch {
      if (alive.current) {
        setUncertain(true);
        setError("Trial 结果未知，可能已发送真实消息。请刷新触发记录核对，不要直接重试。");
      }
    } finally {
      if (alive.current) setPending(false);
    }
  }
  async function rotate() {
    if (!selected || pending || uncertain) return;
    setPending(true);
    secretVersion.current++;
    setSecretLoading(false);
    setSecretError("");
    setRevealed(false);
    try {
      const result = await rotateWebhookSecretFn({
        data: { ruleId: selected.id, expectedRevision: selected.revision },
      });
      if (!alive.current) return;
      if (!result.ok) {
        setSecretError(result.error.message);
        return;
      }
      setSelected(result.data.rule);
      setSecret(result.data.secret);
      setNotice("Secret 已轮换，旧 Secret 已失效。请更新发送方配置。");
    } catch {
      if (alive.current) {
        setUncertain(true);
        setSecretError("轮换结果未知，请刷新页面核对后再操作。");
      }
    } finally {
      if (alive.current) setPending(false);
    }
  }
  async function copySecret() {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret);
      if (alive.current) setNotice("Secret 已复制。");
    } catch {
      if (alive.current) setSecretError("复制失败，请显示 Secret 后手动复制。");
    }
  }
  return (
    <PageFrame
      title={`${ruleId ? "编辑" : "新建"}${titles[kind]}`}
      description="规则属于当前 Project；Trial 会按已保存的配置真实提交工作。"
      back={
        <PageBackLink
          to="/projects/$projectId/settings"
          params={{ projectId }}
          search={{ tab: kind }}
        >
          返回{kind === "cron" ? "定时任务" : "Webhooks"}
        </PageBackLink>
      }
      testId={`${kind}-editor-page`}
    >
      <div className="min-w-0 max-w-full space-y-6">
        {error && (
          <p role="alert" className="break-words text-sm text-destructive">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="break-words text-sm text-muted-foreground">
            {notice}
          </p>
        )}
        {loading && <p className="text-sm text-muted-foreground">读取规则中…</p>}
        <fieldset
          disabled={!ready || pending || uncertain}
          className="min-w-0 max-w-full"
          data-testid={kind === "cron" ? "cron-settings" : "webhook-settings"}
        >
          {ready && (
            <form onSubmit={save} className="min-w-0 space-y-5">
              <label className="block space-y-1 text-sm">
                规则名称
                <input
                  required
                  maxLength={80}
                  className={field}
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </label>
              {kind === "cron" && (
                <div className="grid min-w-0 gap-4 sm:grid-cols-2">
                  <div className="min-w-0 space-y-1">
                    <label htmlFor="cron-expression" className="block text-sm">
                      Cron 表达式
                    </label>
                    <div className="flex items-center gap-1">
                      <input
                        id="cron-expression"
                        required
                        className={`${field} flex-1 font-mono`}
                        value={draft.expression}
                        onChange={(e) => setDraft({ ...draft, expression: e.target.value })}
                      />
                      <Popover.Root>
                        <Popover.Trigger
                          type="button"
                          aria-label="Cron 语法帮助"
                          className="grid size-9 shrink-0 cursor-pointer list-none place-items-center rounded-control border border-transparent text-muted-foreground hover:border-input focus-visible:outline-2 focus-visible:outline-ring max-desktop:size-11"
                        >
                          <CircleHelp size={18} aria-hidden="true" />
                        </Popover.Trigger>
                        <Popover.Portal>
                          <Popover.Positioner
                            side="bottom"
                            align="end"
                            sideOffset={6}
                            className="z-50"
                          >
                            <Popover.Popup
                              className="w-72 max-w-[calc(100vw-3rem)] space-y-2 rounded-container border border-border bg-popover p-4 leading-6 text-popover-foreground shadow-md outline-none"
                              data-testid="cron-help"
                            >
                              <p>
                                五段依次为：分钟（0–59）、小时（0–23）、日（1–31）、月（1–12）、星期（0–7，0
                                / 7 为周日）。
                              </p>
                              <p>
                                * 表示任意；逗号列举，连字符表示范围，/ 表示步长。例如 0 9 * * 1-5
                                表示工作日 09:00，*/15 * * * * 表示每 15 分钟。
                              </p>
                              <p>
                                日和星期都指定时，任一匹配即执行（OR）。所有时间按所选时区计算；命名时区遵循夏令时，UTC
                                偏移保持固定。不补跑离线时段，已有活跃输入时跳过。
                              </p>
                            </Popover.Popup>
                          </Popover.Positioner>
                        </Popover.Portal>
                      </Popover.Root>
                    </div>
                  </div>
                  <label className="block min-w-0 space-y-1 text-sm">
                    时区（IANA）
                    <select
                      aria-label="时区（IANA）"
                      className={field}
                      value={draft.timezone}
                      onChange={(e) => setDraft({ ...draft, timezone: e.target.value })}
                    >
                      <optgroup label="固定 UTC 偏移">
                        {offsetZones.map((z) => (
                          <option key={z.value} value={z.value}>
                            {z.label}
                          </option>
                        ))}
                      </optgroup>
                      <optgroup label="常用地区（遵循当地夏令时）">
                        {namedZones.map((z) => (
                          <option key={z} value={z}>
                            {z}
                          </option>
                        ))}
                      </optgroup>
                      {!offsetZones.some((z) => z.value === draft.timezone) &&
                        !namedZones.includes(draft.timezone) && (
                          <option value={draft.timezone}>{draft.timezone}（已保存）</option>
                        )}
                    </select>
                  </label>
                </div>
              )}
              <label className="block min-w-0 space-y-1 text-sm">
                指令
                <textarea
                  required
                  maxLength={8000}
                  aria-label="指令"
                  className={`${field} min-h-28`}
                  value={draft.instruction}
                  onChange={(e) => setDraft({ ...draft, instruction: e.target.value })}
                />
              </label>
              <label className="block space-y-1 text-sm">
                动作
                <select
                  aria-label="动作"
                  className={field}
                  value={draft.kind}
                  onChange={(e) =>
                    setDraft({ ...draft, kind: e.target.value, chatId: "", agentProfileId: "" })
                  }
                >
                  <option value="dm_agent">DM → Agent</option>
                  <option value="group_agent">Group → Agent</option>
                  <option value="group_owner">Group → 当前 Agent owner</option>
                </select>
              </label>
              {draft.kind !== "dm_agent" && (
                <label className="block space-y-1 text-sm">
                  目标 Chat
                  <select
                    required
                    aria-label="目标 Chat"
                    className={field}
                    value={draft.chatId}
                    onChange={(e) =>
                      setDraft({ ...draft, chatId: e.target.value, agentProfileId: "" })
                    }
                  >
                    <option value="">请选择 Group</option>
                    {chats
                      .filter(
                        (c) => !c.archivedAt && (c.kind === "group" || c.kind === "public_channel"),
                      )
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.title || c.id}
                          {c.kind === "public_channel" ? "（公共频道）" : ""}
                        </option>
                      ))}
                  </select>
                </label>
              )}
              {draft.kind !== "group_owner" && (
                <label className="block space-y-1 text-sm">
                  目标 Agent
                  <select
                    required
                    aria-label="目标 Agent"
                    className={field}
                    value={draft.agentProfileId}
                    onChange={(e) => setDraft({ ...draft, agentProfileId: e.target.value })}
                  >
                    <option value="">请选择 Agent</option>
                    {eligible.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <p className="text-xs leading-6 text-muted-foreground">
                {draft.kind === "dm_agent"
                  ? "选择 Project 中的工作 Agent；实际触发时自动使用或创建你的 DM，无需预先打开会话。"
                  : "Group 包含公共频道。仅有效成员可以执行；当前 owner 为 Human 时跳过 owner 动作。"}
                目标失效时不会自动改投其他 Agent。
              </p>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
                />
                {kind === "cron" ? "启用定时规则" : "启用 Webhook"}
              </label>
              <Button type="submit" loading={pending}>{`保存${titles[kind]}`}</Button>
            </form>
          )}
        </fieldset>
        {selected && (
          <>
            {"nextAt" in selected && (
              <p className="break-words text-sm" data-testid="cron-next">
                下次触发：{nextTime(selected)} · {selected.nextAt}
              </p>
            )}
            {"endpoint" in selected && (
              <section
                aria-label="Webhook 连接信息"
                className="min-w-0 max-w-full space-y-3 rounded-container border border-border p-4"
              >
                <h2 className="text-sm font-medium">连接信息</h2>
                <p className="break-all text-sm">
                  Endpoint：<code>{selected.endpoint}</code>
                </p>
                {secretLoading ? (
                  <p className="text-sm">读取 Secret 中…</p>
                ) : secret ? (
                  <div className="min-w-0 space-y-2">
                    <label className="block space-y-1 text-sm">
                      Secret
                      <input
                        aria-label="Webhook Secret"
                        readOnly
                        type={revealed ? "text" : "password"}
                        value={secret}
                        autoComplete="off"
                        className={`${field} font-mono`}
                      />
                    </label>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        aria-pressed={revealed}
                        onClick={() => setRevealed(!revealed)}
                      >
                        {revealed ? "隐藏 Secret" : "显示 Secret"}
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => void copySecret()}>
                        复制 Secret
                      </Button>
                    </div>
                  </div>
                ) : (
                  !secretError && (
                    <p className="text-sm text-muted-foreground">
                      该旧规则仅保存 Secret 哈希，无法恢复原值。轮换后即可查看并复制新 Secret。
                    </p>
                  )
                )}
                {secretError && (
                  <p role="alert" className="break-words text-sm text-destructive">
                    {secretError}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={secretLoading || pending}
                    onClick={() => void readSecret(selected.id)}
                  >
                    重新读取 Secret
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending || uncertain || dirty}
                    onClick={() => void rotate()}
                  >
                    轮换 Secret（旧值失效）
                  </Button>
                </div>
                <p className="text-xs leading-6 text-muted-foreground">
                  将 Secret 保存到发送方的 WEBHOOK_SECRET 环境变量。每个独立事件使用稳定且唯一的
                  Event ID；相同 ID 可安全重试。
                </p>
                <pre
                  data-testid="webhook-curl"
                  className="w-full min-w-0 max-w-full overflow-x-auto rounded-control bg-muted p-3 text-xs leading-6"
                >
                  <code>{`curl -X POST '${selected.endpoint}' \\\n  -H "Authorization: Bearer $WEBHOOK_SECRET" \\\n  -H 'Content-Type: application/json' \\\n  -H 'X-Sprout-Event-Id: event-123' \\\n  -d '{"message":"hello"}'`}</code>
                </pre>
              </section>
            )}
            <section
              aria-label="Trial"
              className="min-w-0 space-y-3 rounded-container border border-border p-4"
            >
              <h2 className="text-sm font-medium">Trial</h2>
              <p className="text-xs text-muted-foreground">
                按已保存配置发送真实消息。修改后请先保存；停用规则仍会跳过。
                {kind === "cron" && "Trial 不推进下次计划时间。"}
              </p>
              {kind === "webhooks" && (
                <label className="block space-y-1 text-sm">
                  JSON 样例
                  <textarea
                    aria-label="JSON 样例"
                    className={`${field} min-h-24 font-mono`}
                    value={payload}
                    disabled={pending}
                    onChange={(e) => setPayload(e.target.value)}
                  />
                </label>
              )}
              <Button
                variant="outline"
                disabled={pending || dirty || uncertain}
                onClick={() => void trial()}
              >
                Trial {titles[kind]}
              </Button>
            </section>
            <section
              aria-label="触发历史"
              className="min-w-0 space-y-3"
              data-testid={`${kind}-history-section`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-medium">最近触发（最多 50 条）</h2>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={historyLoading}
                  onClick={() => void readHistory(selected.id)}
                >
                  刷新历史
                </Button>
              </div>
              {historyLoading && (
                <p role="status" className="text-sm text-muted-foreground">
                  读取历史中…
                </p>
              )}
              {historyError && (
                <p role="alert" className="text-sm text-destructive">
                  {historyError}
                </p>
              )}
              {!historyLoading && !historyError && !history.length && (
                <p className="text-sm text-muted-foreground">还没有触发记录。</p>
              )}
              {history.length > 0 && (
                <ol
                  className="divide-y divide-border rounded-container border border-border"
                  data-testid={kind === "cron" ? "cron-history" : "webhook-history"}
                >
                  {history.map((item) => (
                    <li key={item.id} className="min-w-0 space-y-1 break-words p-4 text-sm">
                      <p>
                        {item.mode === "trial" ? "Trial" : kind === "cron" ? "Schedule" : "Webhook"}{" "}
                        ·{" "}
                        {"scheduledAt" in item
                          ? (item.scheduledAt ?? item.createdAt)
                          : item.createdAt}{" "}
                        · {item.decision}
                        {item.decision === "skipped" && ` · ${item.reason}`}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        事件 {item.eventId} · {item.inputDisposition ?? "无输入"}
                        {item.cancelReason && ` · 取消原因 ${item.cancelReason}`}
                        {"expression" in item && ` · ${item.expression} · ${item.timezone}`}
                      </p>
                      <div className="flex flex-wrap gap-3 text-xs">
                        {item.chatId && (
                          <Link
                            to="/projects/$projectId/chats/$chatId"
                            params={{ projectId, chatId: item.chatId }}
                            className="underline"
                          >
                            打开 Chat
                          </Link>
                        )}
                        {item.runId && item.chatId && (
                          <span>
                            <a
                              className="underline"
                              href={`/projects/${projectId}/chats/${item.chatId}?run=${item.runId}#selected-run-${item.runId}`}
                            >
                              Run {item.runId}
                            </a>
                            （{item.runStatus}）
                          </span>
                        )}
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </>
        )}
      </div>
    </PageFrame>
  );
}
