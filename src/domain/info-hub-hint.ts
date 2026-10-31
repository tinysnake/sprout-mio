import { createHash } from "node:crypto";
import { INFO_HUB_LIMITS } from "../contracts/info-hub";
import {
  infoHubHintSchema,
  infoHubHintDedupeKeySchema,
  type InfoHubHint,
} from "../contracts/info-hub-hint";
import { readRunScope, type ProjectContext } from "./access";
import { getChatInfo, getProjectInfoHub, InfoHubError } from "./info-hub";

type Change = InfoHubHint["changes"][number];
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Host-owned and run-local. Settlement destroys the entire object; there is no retry queue. */
export class InfoHubHintChannel {
  private basis = new Map<string, { change: Change; fingerprint: string }>();
  private pending = new Map<string, { change: Change; revision: string }>();
  private seen = new Set<string>();
  private pendingSince: number | null = null;
  private lastSent = -Infinity;
  private disposed = false;
  constructor(
    readonly runId: string,
    private readonly ctx: ProjectContext,
    private readonly deliver: (hint: InfoHubHint) => void | Promise<void>,
  ) {
    if (ctx.agent) throw new InfoHubError("forbidden");
    this.basis = this.facts().facts;
  }
  private facts() {
    const scope = readRunScope(this.runId);
    if (!scope?.active) throw new InfoHubError("turn_context_unavailable");
    const hub = getProjectInfoHub(scope.projectId, this.ctx);
    const chat = getChatInfo(scope.chatId, this.ctx);
    const facts = new Map<string, { change: Change; fingerprint: string }>();
    const put = (change: Change, value: unknown) =>
      facts.set(`${change.kind}:${"chatId" in change ? change.chatId : change.machineId}`, {
        change,
        fingerprint: hash(value),
      });
    put(
      { kind: "chat_members", chatId: scope.chatId },
      chat.members.map((member) => ({
        kind: member.memberKind,
        id: member.memberId,
        name: member.displayName,
      })),
    );
    put({ kind: "chat_owner", chatId: scope.chatId }, chat.owner);
    put({ kind: "chat_archived", chatId: scope.chatId }, chat.archived);
    put({ kind: "task_summary", chatId: scope.chatId }, chat.tasks.items);
    put(
      { kind: "agent_status", chatId: scope.chatId },
      chat.members.filter((member) => member.memberKind === "agent"),
    );
    for (const machine of hub.machines.filter(
      (machine) => machine.lease.holderInstanceId === scope.instanceId,
    )) {
      put({ kind: "machine_connection", machineId: machine.machineId }, machine.connection);
      put({ kind: "machine_lease", machineId: machine.machineId }, machine.lease);
    }
    return { scope, facts };
  }
  /** 时间由宿主注入：这个类不读时钟，合并窗口与最小间隔都按传入的同一时刻判断。 */
  async tick(at: number): Promise<void> {
    if (this.disposed) return;
    if (!readRunScope(this.runId)?.active) {
      this.dispose();
      return;
    }
    const { scope, facts } = this.facts();
    const revision = hash([...facts]);
    for (const [key, value] of new Map([...this.basis, ...facts])) {
      if (this.basis.get(key)?.fingerprint === facts.get(key)?.fingerprint) continue;
      const change = facts.get(key)?.change ?? value.change;
      const dedupe = infoHubHintDedupeKeySchema.parse({
        runId: this.runId,
        kind: change.kind,
        targetId: "chatId" in change ? change.chatId : change.machineId,
        revision,
      });
      const dedupeKey = JSON.stringify(dedupe);
      if (this.seen.has(dedupeKey)) continue;
      this.seen.add(dedupeKey);
      this.pending.set(key, { change, revision });
      this.pendingSince ??= at;
    }
    this.basis = facts;
    if (
      this.pendingSince === null ||
      at - this.pendingSince < INFO_HUB_LIMITS.hintMergeWindowMs ||
      at - this.lastSent < INFO_HUB_LIMITS.hintMinimumIntervalMs
    )
      return;
    const changes = [...this.pending.values()].map((value) => value.change);
    // Split by byte budget, retaining unsent changes in this run's memory only.
    const selected: Change[] = [];
    let hint: InfoHubHint | undefined;
    for (const change of changes) {
      const candidate = infoHubHintSchema.safeParse({
        runId: this.runId,
        projectId: scope.projectId,
        chatId: scope.chatId,
        instanceId: scope.instanceId,
        asOf: new Date(at).toISOString(),
        revision,
        heldMachineIds: [
          ...new Set(
            [...selected, change].flatMap((item) => ("machineId" in item ? [item.machineId] : [])),
          ),
        ],
        changes: [...selected, change],
      });
      if (!candidate.success) break;
      selected.push(change);
      hint = candidate.data;
    }
    if (!hint || !readRunScope(this.runId)?.active) {
      this.dispose();
      return;
    }
    for (const change of selected)
      this.pending.delete(
        `${change.kind}:${"chatId" in change ? change.chatId : change.machineId}`,
      );
    this.pendingSince = this.pending.size ? at : null;
    this.lastSent = at;
    // Failed steering is deliberately discarded. Never persist, emit a Chat message, or admit a run.
    try {
      await this.deliver(hint);
    } catch {
      /* ephemeral */
    }
  }
  dispose() {
    this.disposed = true;
    this.basis.clear();
    this.pending.clear();
    this.seen.clear();
  }
}
