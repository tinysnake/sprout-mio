// Deterministic model substitute; production PiSessionProcess, executeRun, grants and HTTP gateway remain real.
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
let opened;
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
async function call(type, input) {
  const response = await fetch(opened.remote.endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${opened.remote.secret}`,
      "content-type": "application/json",
      "x-request-id": `req_${randomUUID()}`,
    },
    body: JSON.stringify({
      version: 2,
      call: { type, input: { projectId: opened.remote.projectId, ...input } },
    }),
  });
  const body = await response.json();
  if (!body.ok) throw new Error(`production HTTP ${type}: ${JSON.stringify(body)}`);
  return body.data;
}
for await (const line of createInterface({ input: process.stdin })) {
  const command = JSON.parse(line);
  try {
    if (command.type === "open") {
      opened = command;
      emit({
        type: "ready",
        id: command.id,
        snapshot: {
          model: "fixture",
          provider: "fixture",
          thinking: "off",
          tools: ["sprout_task_get", "sprout_task_record_append", "sprout_task_complete"],
          extensions: [],
          sessionId: command.sessionId,
          sessionFile: `${command.sessionDirectory}/fixture.jsonl`,
          cwd: command.cwd,
          sdkVersion: "fixture",
          profile: command.profile,
        },
      });
    } else if (command.type === "prompt" && command.text === "等待运行中接续") {
      emit({ type: "input_delivered", id: command.id, messageId: command.messageId });
      await call("chat_automation_get", {});
    } else if (command.type === "prompt" || command.type === "steer") {
      const envelope = JSON.parse(command.text);
      if (
        envelope.kind !== "continuation" ||
        envelope.deliveryId !== command.messageId ||
        envelope.taskIds.length !== 1
      )
        throw new Error("Invalid continuation envelope");
      emit({ type: "input_delivered", id: command.id, messageId: command.messageId });
      let detail = await call("task_get", { taskId: envelope.taskIds[0] });
      detail = (
        await call("task_mutate", {
          action: "record_append",
          taskId: detail.task.id,
          expectedRevision: detail.task.revision,
          body: "真实 HTTP 施工记录：周期接续已完成。",
        })
      ).detail;
      await call("task_mutate", {
        action: "complete",
        taskId: detail.task.id,
        expectedRevision: detail.task.revision,
      });
      emit({
        type: "settled",
        id: command.id,
        text: "负责的 Task 已完成，施工记录已保存。",
        stopReason: "stop",
      });
    } else if (command.type === "close") process.exit(0);
    else if (command.type === "abort")
      emit({ type: "failure", id: command.id, code: "aborted", message: "Fixture aborted" });
  } catch (error) {
    emit({
      type: "failure",
      id: command.id,
      code: "fixture_failure",
      message: String(error).slice(0, 500),
    });
  }
}
