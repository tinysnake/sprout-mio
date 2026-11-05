import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
import { z } from "zod";
import { promptWithTurnContext } from "../../scripts/pi-host-turn-context.mjs";
const capture = (value) =>
  appendFileSync(process.env.SKILL_WIRE_CAPTURE, JSON.stringify(value) + "\n");
const emit = (value) => {
  capture(value);
  process.stdout.write(JSON.stringify(value) + "\n");
};
const submitted = new Set();
let listener;
const session = {
  subscribe(fn) {
    listener = fn;
    return () => {
      listener = undefined;
    };
  },
  async prompt(text, options) {
    capture({ type: "sdk_prompt", text, options });
    listener?.({ type: "agent_start" });
  },
};
const schema = z
  .object({ runId: z.string(), contentHash: z.string(), serializedText: z.string() })
  .passthrough();
for await (const line of createInterface({ input: process.stdin })) {
  const c = JSON.parse(line);
  capture(c);
  if (c.type === "open")
    emit({
      type: "ready",
      id: c.id,
      snapshot: {
        provider: "fixture",
        model: "no-paid-model",
        thinking: "off",
        tools: [],
        extensions: [],
        sessionId: c.sessionId,
        sessionFile: c.sessionDirectory + "/skill-capture.jsonl",
        cwd: c.cwd,
        sdkVersion: "fixture",
        profile: c.profile,
      },
    });
  else if (c.type === "prompt") {
    await promptWithTurnContext(session, c, schema, submitted, emit);
    emit({ type: "input_delivered", id: c.id, messageId: c.messageId });
  } else if (c.type === "steer") {
    emit({ type: "input_delivered", id: c.id, messageId: c.messageId });
    emit({ type: "settled", id: c.id, text: "fixture complete", stopReason: "stop" });
  } else if (c.type === "close") process.exit(0);
}
