import { admitAssistantInput, prepareAssistantSteerContext } from "../../domain/assistant";
import {
  admitContinuation,
  pendingContinuations,
  acknowledgeContinuation,
  rejectContinuation,
} from "../../domain/continuation-delivery";
import { Effect } from "effect";
import {
  MessageSkillError,
  preparePiMessage,
  prepareSyntheticPiMessage,
  type PreparedPiMessage,
} from "../message-skills";
import { ID_PREFIXES } from "../../contracts/ids";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  AgentRunError,
  completeAgentRun,
  firstPendingRunInput,
  getAgentRun,
  markRunInputDelivered,
  pendingRunInputs,
  previousSessionFile,
  recordRunInputDeliveryFailure,
  transitionAgentRun,
  settleAgentRun,
} from "../../domain/agent-run";
import type { queuedRunWork } from "../../domain/agent-run";
import type { ProjectContext } from "../../domain/access";
import { prepareRunRepo, recordRunRepoBasis, RepositoryError } from "../../domain/repository";
import { admitAutomationInput } from "../../domain/automation-input";
import { admitTaskStartInput } from "../../domain/task-input";
import { recordDiagnostic } from "../diagnostics";
import {
  captureTurnContext,
  prepareTurnContext,
  confirmTurnContext,
} from "../../domain/turn-context";
import { InfoHubError } from "../../domain/info-hub";
import { InfoHubHintChannel } from "../../domain/info-hub-hint";
import { markRunNoticeDelivered, noticeDeliveryText, pendingRunNotices } from "../notices";
import { issueRemoteToolGrant, revokeRemoteToolGrant } from "../remote-agent-gateway";
import { machineRuntimeContext } from "../runtime";
import { PiHostFailure, piInstancePaths } from "./process";
import type { PiSessionProcess } from "./process";
import { clearRunActivity, recordRunActivity } from "./run-activity";
import { prepareInheritedResources } from "./skills";
import { filterMemorySkillPaths } from "../../contracts/memory";
import { db } from "../../db";
import { config } from "../../lib/config";
import { getMachine } from "../../domain/machine";
import { resolveMemoryRuntime } from "../memory-runtime";

export type Work = ReturnType<typeof queuedRunWork>[number];
export type PiHostSignals = { readonly isStopping: () => boolean };
/** 投递确认与 run 输入确认共用同一个回调，靠前缀区分 continuation 投递 id。 */
const DELIVERY_ID_PREFIX = `${ID_PREFIXES.continuationDelivery}_`;
/**
 * 通知按 `notice:<id>` 记账，与消息、continuation 的两个前缀都不冲突。只有 runner 回
 * `input_delivered` 才算送达：它回 `input_rejected` 时通知还在 outbox 里，保持
 * `delivered_at=NULL` 并按 `NOTICE_RETRY_MS` 退避重试（否则通知会被标成「已送达」，
 * 却从没进入这一轮的模型上下文）。
 */
const NOTICE_ID_PREFIX = "notice:";
const NOTICE_RETRY_MS = 1_000;

export function executeRun(
  work: Work,
  process: PiSessionProcess,
  signals: PiHostSignals,
  now = () => new Date().getTime(),
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const { run, profile } = work;
    // 执行身份取自 run 自己的记录：`userId` 继续只是 Project 归属（agent_run 的 owner 语义不变），
    // 分身身份取 run 引用的 instance；因此人类消息开出的 run 也以 Agent 身份执行域代码，
    // 宿主不再靠 `userId` 分辨人与 Agent。
    const ctx: ProjectContext = {
      userId: work.ownerId,
      requestId: run.requestId,
      agent: { agentProfileId: work.agentProfileId, instanceId: run.instanceId, runId: run.id },
    };
    const sent = new Set<string>();
    /** 已由 runner 确认送达的通知；`delivered_at` 与它同一时刻落库。 */
    const noticesSent = new Set<string>();
    /** 已写出但未确认的通知：等确认时存 Infinity，被拒后改回下一次允许重试的时刻。 */
    const noticesRetry = new Map<string, number>();
    const close = Effect.tryPromise({ try: () => process.close(), catch: (error) => error });
    const outcome = yield* Effect.exit(
      Effect.gen(function* () {
        const input = yield* Effect.sync(() => firstPendingRunInput(run.id, ctx));
        if (!input && pendingContinuations(run.id).length === 0) {
          yield* Effect.sync(() =>
            transitionAgentRun(run.id, "aborted", { stopReason: "input_invalid" }, ctx),
          );
          return;
        }
        const prepared = yield* Effect.tryPromise({
          try: () =>
            profile.purpose === "assistant"
              ? Promise.resolve(undefined)
              : prepareRunRepo(run.id, ctx),
          catch: (error) => error,
        });
        const paths = yield* Effect.sync(() => piInstancePaths(run.instanceId));
        const sessionFile = yield* Effect.sync(() => previousSessionFile(run.id, ctx));
        const runtime = yield* Effect.tryPromise({
          try: machineRuntimeContext,
          catch: (error) => error,
        });
        const hostContext = { userId: work.ownerId, requestId: run.requestId, ...runtime };
        const grantContext = { ...runtime, requestId: run.requestId };
        const remote = yield* Effect.sync(() => {
          const grant = issueRemoteToolGrant(run.id, process, grantContext);
          process.onDispose(() =>
            revokeRemoteToolGrant(run.id, { ...grantContext, now: new Date(now()) }),
          );
          return grant;
        });
        const memory = yield* Effect.sync(() => {
          if (profile.purpose === "assistant") return { state: "disabled" as const };
          const machineId = config.SPROUT_PI_MACHINE_ID;
          let machineOnline = false;
          if (machineId) {
            try {
              getMachine({ machineId }, hostContext);
              // Pi executes on this host, so a configured and owned Machine is online
              // by definition. Its connection row describes remote agents, not us.
              machineOnline = true;
            } catch {
              // An inaccessible or unknown host cannot supply Project memory.
            }
          }
          return resolveMemoryRuntime({
            db,
            projectId: run.projectId,
            machineId,
            machineOnline,
            dataDir: config.SPROUT_PI_DATA_DIR,
            env: globalThis.process.env,
          });
        });
        const resources = yield* Effect.tryPromise({
          try: () =>
            profile.purpose === "assistant"
              ? Promise.resolve({ kind: "disabled" as const })
              : prepareInheritedResources(run.projectId, ctx),
          catch: (error) => error,
        });
        const snapshot = yield* Effect.tryPromise({
          try: () =>
            process.open({
              type: "open",
              purpose: profile.purpose,
              id: run.id,
              instanceId: run.instanceId,
              sessionId: run.sessionId,
              sessionFile,
              sessionDirectory: paths.sessionDirectory,
              cwd: prepared?.path ?? paths.cwd,
              agentDir: resolve(
                globalThis.process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
              ),
              extensionPath: resolve("pi/sprout-extension.ts"),
              resources:
                resources.kind === "enabled"
                  ? {
                      ...resources,
                      skillPaths: filterMemorySkillPaths(resources.skillPaths, memory.state),
                    }
                  : resources,
              memory,
              remote,
              profile: {
                id: profile.id,
                purpose: profile.purpose,
                name: profile.name,
                persona: profile.persona,
                harness: profile.harness,
                ...(profile.model ? { model: profile.model } : {}),
                ...(profile.effort ? { effort: profile.effort } : {}),
                updatedAt: profile.updatedAt.toISOString(),
              },
            }),
          catch: (error) => error,
        });
        if (signals.isStopping()) return;
        yield* Effect.sync(() => {
          const basis = prepared ? recordRunRepoBasis(run.id, prepared, ctx) : undefined;
          transitionAgentRun(
            run.id,
            "running",
            { configSnapshot: basis ? { ...snapshot, repo: basis } : snapshot },
            ctx,
          );
          process.onDelivered = (messageId, assistantContextHash) => {
            if (signals.isStopping()) return;
            try {
              if (messageId.startsWith(DELIVERY_ID_PREFIX))
                acknowledgeContinuation(messageId, run.id, new Date(now()));
              else if (messageId.startsWith(NOTICE_ID_PREFIX)) {
                noticesSent.add(messageId);
                markRunNoticeDelivered(messageId.slice(NOTICE_ID_PREFIX.length), new Date(now()));
              } else markRunInputDelivered(run.id, messageId, ctx, assistantContextHash);
            } catch (error) {
              // 用户停止后迟到的投递确认保持 pending，不升级成进程故障。
              if (!(error instanceof AgentRunError && error.code === "conflict")) throw error;
            }
          };
          process.onRejected = (messageId, reason) => {
            if (signals.isStopping()) return;
            if (messageId.startsWith(DELIVERY_ID_PREFIX)) rejectContinuation(messageId, run.id);
            else if (messageId.startsWith(NOTICE_ID_PREFIX))
              noticesRetry.set(messageId, now() + NOTICE_RETRY_MS);
            else recordRunInputDeliveryFailure(run.id, messageId, reason, ctx);
          };
          process.onProgress = (event) => recordRunActivity(run.id, event, now());
        });
        // Session/repository preparation can outlive Task responsibility. Select again at
        // the synchronous send boundary; admit persists the attempt before stdin.write.
        const warnSkills = (prepared: PreparedPiMessage) => {
          for (const warning of prepared.warnings)
            recordDiagnostic({
              level: "warn",
              event: "pi.skill_unavailable",
              requestId: run.requestId,
              projectId: run.projectId,
              chatId: run.chatId,
              runId: run.id,
              message: "技能未展开，保留原始 token",
              data: { ...warning },
            });
        };
        const preparedPrompt = yield* Effect.tryPromise({
          try: async () => {
            captureTurnContext({ projectId: run.projectId, runId: run.id }, hostContext);
            process.turnContext = prepareTurnContext(
              { projectId: run.projectId, runId: run.id },
              hostContext,
            );
            process.onTurnContextSubmitted = (receipt) => {
              confirmTurnContext(receipt, hostContext);
            };
            for (;;) {
              const selected = firstPendingRunInput(run.id, ctx);
              if (!selected) {
                const continuation = pendingContinuations(run.id)[0];
                if (continuation) {
                  const attempted = admitContinuation(
                    continuation.deliveryId,
                    run.id,
                    new Date(now()),
                    (envelope) =>
                      process.prompt(
                        prepareSyntheticPiMessage({
                          kind: "continuation",
                          messageId: envelope.deliveryId,
                          text: JSON.stringify(envelope),
                        }),
                      ),
                  );
                  if (attempted) return { task: attempted };
                  continue;
                }
                transitionAgentRun(run.id, "aborted", { stopReason: "input_invalid" }, ctx);
                return undefined;
              }
              const prepared =
                selected.message.assistantProposalId || profile.purpose === "assistant"
                  ? prepareSyntheticPiMessage({
                      kind: selected.message.assistantProposalId
                        ? "assistant_work"
                        : "assistant_human",
                      messageId: selected.message.id,
                      text: selected.message.assistantProposalId
                        ? `[Human-confirmed assistant proposal ${selected.message.assistantProposalId}; source is program-generated work input]\n${selected.message.body}`
                        : selected.message.body,
                    })
                  : selected.message.taskRecordKind === "start"
                    ? prepareSyntheticPiMessage({
                        kind: "task_start",
                        messageId: selected.message.id,
                        text: selected.message.body,
                      })
                    : await preparePiMessage(
                        {
                          projectId: run.projectId,
                          chatId: run.chatId,
                          messageId: selected.message.id,
                        },
                        resources,
                        ctx,
                      );
              if (signals.isStopping()) return undefined;
              if (firstPendingRunInput(run.id, ctx)?.message.id !== selected.message.id) continue;
              const send = () => {
                warnSkills(prepared);
                sent.add(selected.message.id);
                return process.prompt(prepared);
              };
              if (selected.message.assistantProposalId) {
                const attempted = admitAssistantInput(run.id, selected.message.id, send);
                if (attempted) return { task: attempted };
                continue;
              }
              if (selected.message.automationTriggerId) {
                const attempted = admitAutomationInput(run.id, selected.message.id, send);
                if (attempted) return { task: attempted };
                continue;
              }
              if (selected.message.taskRecordKind !== "start") return { task: send() };
              const attempted = admitTaskStartInput(run.id, selected.message.id, send);
              if (attempted) return { task: attempted };
              // Another writer can invalidate responsibility between selection and admit.
              // The rejected row has been cancelled: select the next input before returning.
            }
          },
          catch: (error) => error,
        });
        const promptTask = preparedPrompt?.task;
        if (!promptTask) return;
        const hints = new InfoHubHintChannel(run.id, hostContext, (hint) =>
          process.infoHubHint?.(hint),
        );
        let hintSampleAt = 0;
        const result = yield* Effect.scoped(
          Effect.gen(function* () {
            const runScope = yield* Effect.scope;
            yield* Effect.gen(function* () {
              while (true) {
                yield* Effect.sleep("100 millis");
                const keepPolling = yield* Effect.tryPromise({
                  try: async () => {
                    try {
                      if (signals.isStopping()) return true;
                      if (profile.purpose !== "assistant" && now() - hintSampleAt >= 1000) {
                        hintSampleAt = now();
                        void hints.tick(now()).catch(() => {});
                      }
                      for (const pending of pendingRunInputs(run.id, ctx)) {
                        if (sent.has(pending.messageId)) continue;
                        try {
                          const prepared =
                            pending.assistantProposalId || profile.purpose === "assistant"
                              ? prepareSyntheticPiMessage({
                                  kind: pending.assistantProposalId
                                    ? "assistant_work"
                                    : "assistant_human",
                                  messageId: pending.messageId,
                                  text: pending.assistantProposalId
                                    ? `[Human-confirmed assistant proposal ${pending.assistantProposalId}; source is program-generated work input]\n${pending.text}`
                                    : pending.text,
                                  ...(profile.purpose === "assistant"
                                    ? {
                                        assistantContext: prepareAssistantSteerContext(
                                          run.id,
                                          pending.messageId,
                                          ctx,
                                          new Date(now()),
                                        ),
                                      }
                                    : {}),
                                })
                              : pending.taskRecordKind === "start"
                                ? prepareSyntheticPiMessage({
                                    kind: "task_start",
                                    messageId: pending.messageId,
                                    text: pending.text,
                                  })
                                : await preparePiMessage(
                                    {
                                      projectId: run.projectId,
                                      chatId: run.chatId,
                                      messageId: pending.messageId,
                                    },
                                    resources,
                                    ctx,
                                  );
                          if (signals.isStopping()) return true;
                          if (
                            !pendingRunInputs(run.id, ctx).some(
                              (input) => input.messageId === pending.messageId,
                            )
                          )
                            continue;
                          sent.add(pending.messageId);
                          if (pending.assistantProposalId) {
                            admitAssistantInput(run.id, pending.messageId, () =>
                              process.steer(prepared),
                            );
                          } else if (pending.automationTriggerId) {
                            admitAutomationInput(run.id, pending.messageId, () =>
                              process.steer(prepared),
                            );
                          } else if (pending.taskRecordKind === "start") {
                            admitTaskStartInput(run.id, pending.messageId, () =>
                              process.steer(prepared),
                            );
                          } else {
                            warnSkills(prepared);
                            process.steer(prepared);
                          }
                        } catch (error) {
                          recordRunInputDeliveryFailure(
                            run.id,
                            pending.messageId,
                            error instanceof MessageSkillError
                              ? error.code
                              : "Pi runner 通信失败，消息未投递",
                            ctx,
                          );
                          return false;
                        }
                      }
                      for (const continuation of pendingContinuations(run.id)) {
                        admitContinuation(
                          continuation.deliveryId,
                          run.id,
                          new Date(now()),
                          (envelope) => {
                            process.steer(
                              prepareSyntheticPiMessage({
                                kind: "continuation",
                                messageId: envelope.deliveryId,
                                text: JSON.stringify(envelope),
                              }),
                            );
                            return true;
                          },
                        );
                      }
                      try {
                        for (const notice of pendingRunNotices({ runId: run.id }, ctx)) {
                          const key = `${NOTICE_ID_PREFIX}${notice.id}`;
                          if (noticesSent.has(key)) continue;
                          const retryAt = noticesRetry.get(key);
                          if (retryAt !== undefined && now() < retryAt) continue;
                          // 先记成待确认再写：确认前不重复投递，被拒后按退避重试。
                          process.steer(
                            prepareSyntheticPiMessage({
                              kind: "resource_notice",
                              messageId: key,
                              text: noticeDeliveryText(notice),
                            }),
                          );
                          noticesRetry.set(key, Number.POSITIVE_INFINITY);
                        }
                      } catch {
                        // 通知投递失败保留 delivered_at=NULL 等待下一轮；不拉倒 run 也不重复记已发。
                      }
                      return true;
                    } catch {
                      // 投递轮询失败不拉倒宿主；run 级故障由 prompt 路径报告。
                      return false;
                    }
                  },
                  catch: (error) => error,
                });
                if (!keepPolling) return;
              }
            }).pipe(Effect.forkIn(runScope));
            return yield* Effect.tryPromise({ try: () => promptTask, catch: (error) => error });
          }),
        ).pipe(Effect.ensuring(Effect.sync(() => hints.dispose())));
        yield* close;
        yield* Effect.sync(() => {
          if (!signals.isStopping()) completeAgentRun(run.id, result.text, result.stopReason, ctx);
        });
      }).pipe(
        Effect.catchDefect((error) => Effect.fail(error)),
        Effect.catch((error) =>
          Effect.sync(() => {
            if (!signals.isStopping()) {
              const current = getAgentRun(run.id, ctx);
              if (current.status === "queued" || current.status === "running") {
                const failure =
                  error instanceof PiHostFailure
                    ? error
                    : error instanceof RepositoryError ||
                        error instanceof InfoHubError ||
                        error instanceof MessageSkillError
                      ? new PiHostFailure(error.code, error.message)
                      : new PiHostFailure("run_failed", "Agent run 执行失败");
                // 与宿主级诊断一样保留原因；只取错误分类和消息，不序列化异常附带的凭据等字段。
                const diagnostic = {
                  level: "error" as const,
                  event: "pi_host.run_failed",
                  requestId: run.requestId,
                  projectId: run.projectId,
                  chatId: run.chatId,
                  instanceId: run.instanceId,
                  runId: run.id,
                  message: "Agent run 执行失败",
                  data: {
                    errorName: error instanceof Error ? error.name : "UnknownError",
                    ...(error instanceof Error && "code" in error && typeof error.code === "string"
                      ? { errorCode: error.code }
                      : {}),
                    cause:
                      error instanceof Error
                        ? error.message
                        : typeof error === "string"
                          ? error
                          : "未知错误",
                  },
                };
                console.error("[pi-host] Run 执行失败", diagnostic);
                recordDiagnostic(diagnostic);
                const data = {
                  errorCode: failure.code,
                  errorMessage: failure.message,
                  stopReason: failure.stopReason,
                };
                if (current.status === "queued") transitionAgentRun(run.id, "failed", data, ctx);
                else
                  settleAgentRun(run.id, { status: "failed", ...data, reply: failure.text }, ctx);
              }
            }
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            process.onProgress = undefined;
            clearRunActivity(run.id);
          }),
        ),
      ),
    );
    yield* close.pipe(Effect.catch(() => Effect.void));
    yield* outcome;
  });
}
