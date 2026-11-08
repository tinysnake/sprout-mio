import { useEffect, useRef, useState } from "react";
import type { AgentProfile, ProjectMember } from "../../contracts/agent";
import type {
  AutomationAction,
  AutomationHistory,
  CronRule,
  CronRuleDraft,
  CronTrigger,
} from "../../contracts/automation";
import type { Chat } from "../../contracts/chat";
import { listAgentProfilesFn, listProjectMembersFn } from "../../server/functions/agent";
import {
  createCronRuleFn,
  cronHistoryFn,
  listCronRulesFn,
  trialCronFn,
  updateCronRuleFn,
} from "../../server/functions/automation";
import { listChatMembersFn, listChatsFn } from "../../server/functions/chat";
import { Button } from "../ui/button";
import { SettingsSection } from "./settings-section";

const initial = {
  name: "",
  instruction: "",
  enabled: false,
  expression: "0 9 * * *",
  timezone: "UTC",
  kind: "group_owner",
  chatId: "",
  agentProfileId: "",
};
type Draft = typeof initial;
function edit(rule: CronRule): Draft {
  return {
    name: rule.name,
    instruction: rule.instruction,
    enabled: rule.enabled,
    expression: rule.expression,
    timezone: rule.timezone,
    kind: rule.action.kind,
    chatId: rule.action.chatId,
    agentProfileId: rule.action.kind === "group_owner" ? "" : rule.action.agentProfileId,
  };
}
export function CronSettings({ projectId }: { projectId: string }) {
  const [rules, setRules] = useState<CronRule[]>([]);
  const [chats, setChats] = useState<Chat[]>([]);
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [chatAgentIds, setChatAgentIds] = useState<string[]>([]);
  const [selected, setSelected] = useState<CronRule | null>(null);
  const [draft, setDraft] = useState<Draft>(initial);
  const [history, setHistory] = useState<AutomationHistory<CronTrigger>[]>([]);
  const [loading, setLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    let live = true;
    Promise.all([
      listCronRulesFn({ data: { projectId } }),
      listChatsFn({ data: { projectId } }),
      listAgentProfilesFn(),
      listProjectMembersFn({ data: { projectId } }),
    ])
      .then(([r, c, a, m]) => {
        if (!live) return;
        if (!r.ok || !c.ok || !a.ok || !m.ok) {
          setError("定时规则或目标读取失败，请刷新页面。");
          return;
        }
        setRules(r.data);
        setChats(c.data);
        setAgents(a.data);
        setMembers(m.data);
      })
      .catch(() => {
        if (live) setError("定时规则读取失败，请刷新页面。");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
      generation.current++;
    };
  }, [projectId]);
  useEffect(() => {
    let live = true;
    setChatAgentIds([]);
    if (draft.chatId)
      void listChatMembersFn({ data: { chatId: draft.chatId } })
        .then((result) => {
          if (!live) return;
          if (result.ok)
            setChatAgentIds(
              result.data.filter((m) => m.memberKind === "agent").map((m) => m.memberId),
            );
          else setError(result.error.message);
        })
        .catch(() => {
          if (live) setError("Chat 成员读取失败。");
        });
    return () => {
      live = false;
    };
  }, [draft.chatId]);
  async function readHistory(rule: CronRule | null) {
    const current = ++generation.current;
    setHistory([]);
    setHistoryLoading(Boolean(rule));
    if (!rule) return;
    try {
      const [result, latest] = await Promise.all([
        cronHistoryFn({ data: { ruleId: rule.id } }),
        listCronRulesFn({ data: { projectId } }),
      ]);
      if (generation.current !== current) return;
      if (result.ok) setHistory(result.data);
      else setError(result.error.message);
      if (latest.ok) {
        setRules(latest.data);
        const fresh = latest.data.find((entry) => entry.id === rule.id);
        if (fresh && fresh.revision === rule.revision)
          setSelected((value) =>
            value?.id === rule.id ? { ...value, nextAt: fresh.nextAt } : value,
          );
      } else setError(latest.error.message);
    } catch {
      if (generation.current === current) setError("触发历史读取失败。");
    } finally {
      if (generation.current === current) setHistoryLoading(false);
    }
  }
  function choose(rule: CronRule | null) {
    setSelected(rule);
    setDraft(rule ? edit(rule) : initial);
    setError("");
    setNotice("");
    void readHistory(rule);
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError("");
    setNotice("");
    const action: AutomationAction =
      draft.kind === "group_owner"
        ? { kind: "group_owner", chatId: draft.chatId }
        : {
            kind: draft.kind === "dm_agent" ? "dm_agent" : "group_agent",
            chatId: draft.chatId,
            agentProfileId: draft.agentProfileId,
          };
    const data: CronRuleDraft = {
      projectId,
      name: draft.name,
      instruction: draft.instruction,
      enabled: draft.enabled,
      expression: draft.expression,
      timezone: draft.timezone,
      action,
    };
    try {
      const result = selected
        ? await updateCronRuleFn({
            data: { ...data, ruleId: selected.id, expectedRevision: selected.revision },
          })
        : await createCronRuleFn({ data });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setRules((current) => [result.data, ...current.filter((r) => r.id !== result.data.id)]);
      setSelected(result.data);
      setDraft(edit(result.data));
      setNotice("定时规则已保存。");
      await readHistory(result.data);
    } catch {
      setUncertain(true);
      setError("保存结果未知，可能已提交。请刷新页面核对，不要直接重试。");
    } finally {
      setPending(false);
    }
  }
  async function trial() {
    if (!selected) return;
    setPending(true);
    setError("");
    setNotice("");
    try {
      const result = await trialCronFn({
        data: { ruleId: selected.id, eventId: crypto.randomUUID() },
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setNotice(
        `Trial：${result.data.decision}${result.data.decision === "skipped" ? ` · ${result.data.reason}` : ""}`,
      );
      await readHistory(selected);
    } catch {
      setUncertain(true);
      setError("Trial 结果未知，可能已触发真实消息。请刷新历史核对，不要直接重试。");
    } finally {
      setPending(false);
    }
  }
  const eligible = agents.filter(
    (agent) =>
      members.some((m) => m.agentProfileId === agent.id) && chatAgentIds.includes(agent.id),
  );
  const dirty = JSON.stringify(draft) !== JSON.stringify(selected ? edit(selected) : initial);
  return (
    <SettingsSection
      title="定时规则"
      description="按明确时区发送 Project 消息。五段 cron（分钟、小时、日、月、星期）；离线与重启不补跑，同规则仍有活跃输入时跳过。"
    >
      {error && (
        <p role="alert" className="break-words text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
      <fieldset
        disabled={loading || pending || uncertain}
        className="min-w-0 space-y-4"
        data-testid="cron-settings"
      >
        <div className="flex flex-wrap gap-2">
          {rules.map((rule) => (
            <Button
              key={rule.id}
              variant={selected?.id === rule.id ? "secondary" : "outline"}
              size="sm"
              onClick={() => choose(rule)}
            >
              {rule.name} · {rule.enabled ? "启用" : "停用"}
            </Button>
          ))}
          <Button variant="outline" size="sm" onClick={() => choose(null)}>
            新建定时规则
          </Button>
        </div>
        {loading ? (
          <p className="text-sm text-muted-foreground">读取中…</p>
        ) : (
          <form onSubmit={save} className="space-y-4">
            <label className="block space-y-1 text-sm">
              规则名称
              <input
                className="block w-full min-w-0 rounded-control border border-input bg-background px-3 py-2"
                required
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block space-y-1 text-sm">
                Cron 表达式
                <input
                  className="block w-full min-w-0 rounded-control border border-input bg-background px-3 py-2 font-mono"
                  required
                  value={draft.expression}
                  onChange={(e) => setDraft({ ...draft, expression: e.target.value })}
                />
              </label>
              <label className="block space-y-1 text-sm">
                时区（IANA）
                <input
                  className="block w-full min-w-0 rounded-control border border-input bg-background px-3 py-2"
                  required
                  placeholder="Asia/Shanghai"
                  value={draft.timezone}
                  onChange={(e) => setDraft({ ...draft, timezone: e.target.value })}
                />
              </label>
            </div>
            <label className="block space-y-1 text-sm">
              指令
              <textarea
                aria-label="指令"
                className="block w-full min-w-0 rounded-control border border-input bg-background px-3 py-2 min-h-24"
                required
                value={draft.instruction}
                onChange={(e) => setDraft({ ...draft, instruction: e.target.value })}
              />
            </label>
            <label className="block space-y-1 text-sm">
              动作
              <select
                className="block w-full min-w-0 rounded-control border border-input bg-background px-3 py-2"
                aria-label="动作"
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
            <label className="block space-y-1 text-sm">
              目标 Chat
              <select
                className="block w-full min-w-0 rounded-control border border-input bg-background px-3 py-2"
                required
                aria-label="目标 Chat"
                value={draft.chatId}
                onChange={(e) => setDraft({ ...draft, chatId: e.target.value, agentProfileId: "" })}
              >
                <option value="">请选择 Chat</option>
                {chats
                  .filter(
                    (c) => !c.archivedAt && c.kind === (draft.kind === "dm_agent" ? "dm" : "group"),
                  )
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title || c.id}
                    </option>
                  ))}
              </select>
            </label>
            {draft.kind !== "group_owner" && (
              <label className="block space-y-1 text-sm">
                目标 Agent
                <select
                  className="block w-full min-w-0 rounded-control border border-input bg-background px-3 py-2"
                  required
                  aria-label="目标 Agent"
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
            <p className="text-xs text-muted-foreground">
              不会自动改投其他 Agent。owner 为 Human 时仅跳过 owner 动作。Trial
              发送已保存配置的真实消息，不推进下次时间。
            </p>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
              />
              启用定时规则
            </label>
            <div className="flex flex-wrap gap-2">
              <Button type="submit">{pending ? "处理中…" : "保存定时规则"}</Button>
              <Button
                type="button"
                variant="outline"
                disabled={!selected || dirty}
                onClick={() => void trial()}
              >
                Trial 定时规则
              </Button>
            </div>
          </form>
        )}
        {selected && (
          <div className="min-w-0 space-y-3 text-sm">
            <p className="break-words" data-testid="cron-next">
              下次触发（刷新历史更新）：
              {selected.nextAt
                ? `${new Date(selected.nextAt).toLocaleString("zh-CN", { timeZone: selected.timezone })}（${selected.timezone}） · ${selected.nextAt}`
                : "停用，无下次时间"}
            </p>
            <div className="flex items-center gap-2">
              <h3 className="font-medium">最近触发（最多 50 条）</h3>
              <Button variant="ghost" size="sm" onClick={() => void readHistory(selected)}>
                刷新历史
              </Button>
            </div>
            {historyLoading ? (
              <p>读取历史中…</p>
            ) : !history.length ? (
              <p className="text-muted-foreground">还没有触发记录。</p>
            ) : (
              <ol className="space-y-2" data-testid="cron-history">
                {history.map((item) => (
                  <li key={item.id} className="break-words rounded-md border p-3">
                    <p>
                      {item.mode === "trial" ? "Trial" : "Schedule"} ·{" "}
                      {item.scheduledAt ?? item.createdAt} · {item.decision}
                      {item.decision === "skipped" && ` · ${item.reason}`}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {item.expression} · {item.timezone} · {item.inputDisposition ?? "无输入"}
                      {item.cancelReason && ` · 取消原因 ${item.cancelReason}`}
                    </p>
                    {item.chatId && (
                      <a className="underline" href={`/projects/${projectId}/chats/${item.chatId}`}>
                        打开 Chat
                      </a>
                    )}
                    {item.runId && (
                      <span>
                        {" "}
                        ·{" "}
                        <a
                          className="underline"
                          href={`/projects/${projectId}/chats/${item.chatId}#run-${item.runId}`}
                        >
                          Run {item.runId}
                        </a>
                        （{item.runStatus}）
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
      </fieldset>
    </SettingsSection>
  );
}
