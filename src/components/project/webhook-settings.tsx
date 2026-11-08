import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import type { WebhookRule, WebhookAction, WebhookRuleDraft } from "../../contracts/automation";
import { ID_PREFIXES, newId } from "../../contracts/ids";
import { listChatMembersFn, listChatsFn } from "../../server/functions/chat";
import { listAgentProfilesFn } from "../../server/functions/agent";
import {
  createWebhookRuleFn,
  listWebhookRulesFn,
  trialWebhookFn,
  updateWebhookRuleFn,
  webhookHistoryFn,
} from "../../server/functions/automation";
import { SettingsSection } from "./settings-section";

type ChatOption = { id: string; title: string; kind: string };
type AgentOption = { id: string; name: string };
export function WebhookSettings({ projectId }: { projectId: string }) {
  const [rules, setRules] = useState<WebhookRule[]>([]);
  const [chats, setChats] = useState<ChatOption[]>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [selected, setSelected] = useState("");
  const [draft, setDraft] = useState({
    name: "",
    instruction: "",
    enabled: true,
    kind: "group_agent",
    chatId: "",
    agentProfileId: "",
  });
  const [secret, setSecret] = useState("");
  const [secretRule, setSecretRule] = useState<WebhookRule | null>(null);
  const [history, setHistory] = useState<
    Extract<Awaited<ReturnType<typeof webhookHistoryFn>>, { ok: true }>["data"]
  >([]);
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [payload, setPayload] = useState('{"message":"hello"}');
  const [notice, setNotice] = useState("");
  const refresh = async () => {
    const result = await listWebhookRulesFn({ data: { projectId } });
    if (result.ok) setRules(result.data);
  };
  useEffect(() => {
    void refresh();
    void listChatsFn({ data: { projectId } }).then((r) => {
      if (r.ok)
        setChats(
          r.data
            .filter((c) => c.kind !== "public_channel")
            .map((c) => ({ id: c.id, title: c.title ?? c.id, kind: c.kind })),
        );
    });
    void listAgentProfilesFn().then((r) => {
      if (r.ok) setAgents(r.data.map((a) => ({ id: a.id, name: a.name })));
    });
  }, [projectId]);
  useEffect(() => {
    let current = true;
    setMemberIds([]);
    if (draft.chatId)
      void listChatMembersFn({ data: { chatId: draft.chatId } }).then((result) => {
        if (!current) return;
        if (result.ok)
          setMemberIds(result.data.filter((m) => m.memberKind === "agent").map((m) => m.memberId));
        else setNotice(result.error.message);
      });
    return () => {
      current = false;
    };
  }, [draft.chatId]);
  const eligibleAgents = agents.filter((agent) => memberIds.includes(agent.id));
  const current = rules.find((r) => r.id === selected);
  const action: WebhookAction | null =
    draft.kind === "group_owner"
      ? { kind: "group_owner", chatId: draft.chatId }
      : draft.chatId && draft.agentProfileId
        ? {
            kind: draft.kind as "dm_agent" | "group_agent",
            chatId: draft.chatId,
            agentProfileId: draft.agentProfileId,
          }
        : null;
  const save = async () => {
    if (!action) return;
    const data: WebhookRuleDraft = {
      projectId,
      name: draft.name,
      instruction: draft.instruction,
      enabled: draft.enabled,
      action,
    };
    const result = current
      ? await updateWebhookRuleFn({
          data: { ...data, ruleId: current.id, expectedRevision: current.revision },
        })
      : await createWebhookRuleFn({ data });
    if (!result.ok) {
      setNotice(result.error.message);
      return;
    }
    if ("secret" in result.data) {
      setSecret(result.data.secret);
      setSecretRule(result.data.rule);
    }
    const savedRule = "rule" in result.data ? result.data.rule : result.data;
    setSelected(savedRule.id);
    setNotice("已保存");
    await refresh();
  };
  const load = (rule: WebhookRule) => {
    setNotice("");
    setHistory([]);
    setSelected(rule.id);
    setDraft({
      name: rule.name,
      instruction: rule.instruction,
      enabled: rule.enabled,
      kind: rule.action.kind,
      chatId: rule.action.chatId,
      agentProfileId: "agentProfileId" in rule.action ? rule.action.agentProfileId : "",
    });
    setSecret("");
    void webhookHistoryFn({ data: { ruleId: rule.id } }).then((r) => {
      if (r.ok) setHistory(r.data);
    });
  };
  const trial = async () => {
    if (!current) return;
    try {
      const data: unknown = JSON.parse(payload);
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new Error("样例必须是 JSON object");
      const result = await trialWebhookFn({
        data: {
          ruleId: current.id,
          eventId: newId(ID_PREFIXES.webhookTrigger),
          payload: data as Record<string, unknown>,
        },
      });
      setNotice(result.ok ? `Trial 已提交：${result.data.decision}` : result.error.message);
      void webhookHistoryFn({ data: { ruleId: current.id } }).then((r) => {
        if (r.ok) setHistory(r.data);
      });
    } catch {
      setNotice("JSON 格式无效");
    }
  };
  return (
    <SettingsSection
      title="Webhook 自动化"
      description="可信来源 POST JSON object；每个事件由 Event ID 幂等接收。Trial 会真实提交到所选 Chat。"
    >
      <div className="space-y-4" data-testid="webhook-settings">
        <div className="flex flex-wrap gap-2">
          {rules.map((rule) => (
            <button
              key={rule.id}
              type="button"
              className="rounded-control border border-input px-3 py-2"
              onClick={() => load(rule)}
            >
              {rule.name} · {rule.enabled ? "启用" : "停用"}
            </button>
          ))}
          <button
            type="button"
            className="underline"
            onClick={() => {
              setSelected("");
              setSecret("");
              setDraft({
                name: "",
                instruction: "",
                enabled: true,
                kind: "group_agent",
                chatId: "",
                agentProfileId: "",
              });
            }}
          >
            新建
          </button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            名称
            <input
              className="h-9 rounded-control border border-input bg-background px-3"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1">
            目标类型
            <select
              className="h-9 rounded-control border border-input bg-background px-3"
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
          <label className="flex flex-col gap-1">
            Project Chat
            <select
              className="h-9 rounded-control border border-input bg-background px-3"
              value={draft.chatId}
              onChange={(e) => setDraft({ ...draft, chatId: e.target.value, agentProfileId: "" })}
            >
              <option value="">选择 Chat</option>
              {chats
                .filter((c) => c.kind === (draft.kind === "dm_agent" ? "dm" : "group"))
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
            </select>
          </label>
          {draft.kind !== "group_owner" && (
            <label className="flex flex-col gap-1">
              Agent
              <select
                className="h-9 rounded-control border border-input bg-background px-3"
                value={draft.agentProfileId}
                onChange={(e) => setDraft({ ...draft, agentProfileId: e.target.value })}
              >
                <option value="">选择 Agent</option>
                {eligibleAgents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="flex flex-col gap-1 sm:col-span-2">
            Instruction
            <textarea
              className="min-h-24 rounded-control border border-input bg-background p-3"
              value={draft.instruction}
              onChange={(e) => setDraft({ ...draft, instruction: e.target.value })}
            />
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
            />
            启用
          </label>
        </div>
        <button
          type="button"
          className="rounded-control bg-primary px-4 py-2 text-primary-foreground"
          onClick={() => void save()}
        >
          保存
        </button>
        {notice && <p role="status">{notice}</p>}
        {secret && secretRule && (
          <div className="break-all rounded-lg border border-input p-3">
            <p>Secret 仅显示一次，请立即复制。</p>
            <code>{secret}</code>
            <p>
              Endpoint：<code>{secretRule.endpoint}</code>
            </p>
            <pre className="overflow-auto">{`curl -X POST '${secretRule.endpoint}' -H 'Authorization: Bearer ${secret}' -H 'Content-Type: application/json' -H 'X-Sprout-Event-Id: event-123' -d '{"message":"hello"}'`}</pre>
          </div>
        )}
        {current && (
          <>
            <label className="flex flex-col gap-1">
              Trial JSON（会真实提交）
              <textarea
                className="min-h-20 rounded-control border border-input bg-background p-3 font-mono"
                value={payload}
                onChange={(e) => setPayload(e.target.value)}
              />
            </label>
            <button type="button" className="underline" onClick={() => void trial()}>
              提交真实 Trial
            </button>
            <h3 className="font-medium">最近触发记录</h3>
            <ol className="space-y-2">
              {history.map((item) => (
                <li key={item.id} className="border-b border-border py-2">
                  {item.mode} · {item.decision === "accepted" ? "已提交" : `跳过：${item.reason}`} ·{" "}
                  {item.eventId} · {item.createdAt}
                  {item.chatId && (
                    <Link
                      className="ml-2 underline"
                      to="/projects/$projectId/chats/$chatId"
                      params={{ projectId, chatId: item.chatId }}
                    >
                      查看 Chat
                    </Link>
                  )}
                  {item.inputDisposition && <span> · 输入 {item.inputDisposition}</span>}
                  {item.cancelReason && <span> · 取消原因 {item.cancelReason}</span>}
                  {item.runId && (
                    <span>
                      {" "}
                      · Run {item.runId} ({item.runStatus})
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
    </SettingsSection>
  );
}
