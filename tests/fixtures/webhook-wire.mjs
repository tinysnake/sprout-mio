import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  if (command.type === "close") process.exit(0);
  if (command.type === "abort")
    out({ type: "settled", id: command.id, text: "", stopReason: "aborted" });
  if (command.type === "open")
    out({
      type: "ready",
      id: command.id,
      snapshot: {
        provider: "wire-test",
        model: "none",
        thinking: "off",
        tools: [],
        extensions: [],
        sessionId: command.sessionId,
        sessionFile: `${command.sessionDirectory}/wire.jsonl`,
        cwd: command.cwd,
        sdkVersion: "wire-test",
        profile: command.profile,
      },
    });
  if (command.type === "prompt" || command.type === "steer") {
    appendFileSync(process.env.WEBHOOK_TRACE, `${JSON.stringify(command)}\n`);
    out({ type: "input_delivered", id: command.id, messageId: command.messageId });
    const content = JSON.parse(command.text).content;
    const awaitSteer = content.event?.awaitSteer || content.instruction.includes("AWAIT_STEER");
    if (command.type === "steer" || !awaitSteer)
      out({ type: "settled", id: command.id, text: "Wire lifecycle result", stopReason: "stop" });
  }
});
