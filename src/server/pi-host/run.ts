import {
  admitContinuation,
  pendingContinuations,
  acknowledgeContinuation,
  rejectContinuation,
} from "../../domain/continuation-delivery";
import { Effect } from "effect";
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
} from "../../domain/agent-run";
import type { queuedRunWork } from "../../domain/agent-run";
import type { ProjectContext } from "../../domain/access";
import { prepareRunRepo, recordRunRepoBasis, RepositoryError } from "../../domain/repository";
import { admitTaskStartInput } from "../../domain/task-input";
import { recordDiagnostic } from "../diagnostics";
import { markRunNoticeDelivered, noticeDeliveryText, pendingRunNotices } from "../notices";
import { issueRemoteToolGrant, revokeRemoteToolGrant } from "../remote-agent-gateway";
import { machineRuntimeContext } from "../runtime";
import { PiHostFailure, piInstancePaths } from "./process";
import type { PiSessionProcess } from "./process";

export type Work = ReturnType<typeof queuedRunWork>[number];
export type PiHostSignals = { readonly isStopping: () => boolean };

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
    /** 与 messageId 共用 sent 而不冲突：通知按 `notice:<id>` 记账，只有成功交付才加入。 */
    const noticesSent = new Set<string>();
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
          try: () => prepareRunRepo(run.id, ctx),
          catch: (error) => error,
        });
        const paths = yield* Effect.sync(() => piInstancePaths(run.instanceId));
        const sessionFile = yield* Effect.sync(() => previousSessionFile(run.id, ctx));
        const runtime = yield* Effect.tryPromise({
          try: machineRuntimeContext,
          catch: (error) => error,
        });
        const grantContext = { ...runtime, requestId: run.requestId };
        const remote = yield* Effect.sync(() => {
          const grant = issueRemoteToolGrant(run.id, process, grantContext);
          process.onDispose(() =>
            revokeRemoteToolGrant(run.id, { ...grantContext, now: new Date(now()) }),
          );
          return grant;
        });
        const snapshot = yield* Effect.tryPromise({
          try: () =>
            process.open({
              type: "open",
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
              remote,
              profile: {
                id: profile.id,
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
          process.onDelivered = (messageId) => {
            if (signals.isStopping()) return;
            try {
              if (messageId.startsWith("delivery_"))
                acknowledgeContinuation(messageId, run.id, new Date(now()));
              else markRunInputDelivered(run.id, messageId, ctx);
            } catch (error) {
              // 用户停止后迟到的投递确认保持 pending，不升级成进程故障。
              if (!(error instanceof AgentRunError && error.code === "conflict")) throw error;
            }
          };
          process.onRejected = (messageId, reason) => {
            if (!signals.isStopping()) {
              if (messageId.startsWith("delivery_")) rejectContinuation(messageId, run.id);
              else recordRunInputDeliveryFailure(run.id, messageId, reason, ctx);
            }
          };
        });
        // Session/repository preparation can outlive Task responsibility. Select again at
        // the synchronous send boundary; admit persists the attempt before stdin.write.
        const promptTask = yield* Effect.sync(() => {
          for (;;) {
            const selected = firstPendingRunInput(run.id, ctx);
            if (!selected) {
              const continuation = pendingContinuations(run.id)[0];
              if (continuation) {
                const attempted = admitContinuation(
                  continuation.deliveryId,
                  run.id,
                  new Date(now()),
                  (envelope) => process.prompt(envelope.deliveryId, JSON.stringify(envelope)),
                );
                if (attempted) return attempted;
                continue;
              }
              transitionAgentRun(run.id, "aborted", { stopReason: "input_invalid" }, ctx);
              return undefined;
            }
            const send = () => {
              sent.add(selected.message.id);
              return process.prompt(selected.message.id, selected.message.body);
            };
            if (selected.message.taskRecordKind !== "start") return send();
            const attempted = admitTaskStartInput(run.id, selected.message.id, send);
            if (attempted) return attempted;
            // Another writer can invalidate responsibility between selection and admit.
            // The rejected row has been cancelled: select the next input before returning.
          }
        });
        if (!promptTask) return;
        const result = yield* Effect.scoped(
          Effect.gen(function* () {
            const runScope = yield* Effect.scope;
            yield* Effect.gen(function* () {
              while (true) {
                yield* Effect.sleep("100 millis");
                const keepPolling = yield* Effect.sync(() => {
                  try {
                    if (signals.isStopping()) return true;
                    for (const pending of pendingRunInputs(run.id, ctx)) {
                      if (sent.has(pending.messageId)) continue;
                      sent.add(pending.messageId);
                      try {
                        if (pending.taskRecordKind === "start") {
                          admitTaskStartInput(run.id, pending.messageId, () =>
                            process.steer(pending.messageId, pending.text),
                          );
                        } else process.steer(pending.messageId, pending.text);
                      } catch {
                        recordRunInputDeliveryFailure(
                          run.id,
                          pending.messageId,
                          "Pi runner 通信失败，消息未投递",
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
                          process.steer(envelope.deliveryId, JSON.stringify(envelope));
                          return true;
                        },
                      );
                    }
                    try {
                      for (const notice of pendingRunNotices({ runId: run.id }, ctx)) {
                        const key = `notice:${notice.id}`;
                        if (noticesSent.has(key)) continue;
                        process.steer(key, noticeDeliveryText(notice));
                        noticesSent.add(key);
                        markRunNoticeDelivered(notice.id, new Date(now()));
                      }
                    } catch {
                      // 通知投递失败保留 delivered_at=NULL 等待下一轮；不拉倒 run 也不重复记已发。
                    }
                    return true;
                  } catch {
                    // 投递轮询失败不拉倒宿主；run 级故障由 prompt 路径报告。
                    return false;
                  }
                });
                if (!keepPolling) return;
              }
            }).pipe(Effect.forkIn(runScope));
            return yield* Effect.tryPromise({ try: () => promptTask, catch: (error) => error });
          }),
        );
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
                    : error instanceof RepositoryError
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
                transitionAgentRun(
                  run.id,
                  "failed",
                  {
                    errorCode: failure.code,
                    errorMessage: failure.message,
                    stopReason: failure.stopReason,
                  },
                  ctx,
                );
              }
            }
          }),
        ),
      ),
    );
    yield* close.pipe(Effect.catch(() => Effect.void));
    yield* outcome;
  });
}
