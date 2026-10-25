import { createInterface } from "node:readline";

const output = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
let callback = 0;
const pending = new Map<number, string | number>();
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (pending.has(message.id) && !message.method) {
    const id = pending.get(message.id);
    pending.delete(message.id);
    output({ jsonrpc: "2.0", id, result: { callback: message.result } });
    continue;
  }
  if (message.method === "fixture/burst") {
    for (let index = 0; index < 6; index++)
      output({
        jsonrpc: "2.0",
        method: "fixture/notice",
        params: { index, data: "x".repeat(100000) },
      });
  } else if (message.method === "fixture/sampling" || message.method === "fixture/elicitation") {
    const id = --callback;
    pending.set(id, message.id);
    output({
      jsonrpc: "2.0",
      id,
      method:
        message.method === "fixture/sampling" ? "sampling/createMessage" : "elicitation/create",
      params: {},
    });
  } else if (message.method === "fixture/exit") process.exit(17);
  else if (message.id !== undefined)
    output({ jsonrpc: "2.0", id: message.id, result: { echo: message.params ?? null } });
}
