// Deterministic model substitute; production PiSessionProcess and grant wiring remain real.
import { createInterface } from "node:readline";
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
for await (const line of createInterface({ input: process.stdin })) {
  const command = JSON.parse(line);
  try {
    if (command.type === "open") {
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
    } else if (command.type === "prompt" || command.type === "steer") {
      emit({ type: "input_delivered", id: command.id, messageId: command.messageId });
      emit({ type: "settled", id: command.id, text: "Fixture run settled.", stopReason: "stop" });
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
