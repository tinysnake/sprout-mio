/**
 * Minimal Pi RPC client for the P0-d probe.
 *
 * Protocol rules this client honors (docs/rpc.md):
 * - one JSON object per LF-terminated line, both directions
 * - split on LF only, not on Unicode line separators
 * - keep reading stdout for the whole process lifetime
 * - stdin close requests an orderly shutdown
 */
import { spawn } from "node:child_process";

export function startPi(args, options = {}) {
  const child = spawn(options.piBin ?? process.env.PI_BIN ?? "/Users/snake/.pi/agent/bin/pi", args, {
    cwd: options.cwd ?? process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  const records = [];
  const stderr = [];
  const listeners = new Set();
  let buffer = "";
  let exited = false;
  let exitInfo = null;

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const raw = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      if (raw.length > 0) {
        let record;
        try {
          record = JSON.parse(raw);
        } catch {
          record = { type: "unparsed", raw };
        }
        records.push(record);
        for (const listener of listeners) listener(record);
      }
      nl = buffer.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk) => stderr.push(chunk.toString("utf8")));
  child.on("exit", (code, signal) => {
    exited = true;
    exitInfo = { code, signal };
  });

  let nextId = 1;
  const send = (command) => {
    const id = command.id ?? `req-${nextId++}`;
    child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    return id;
  };

  const waitFor = (predicate, timeoutMs, label) =>
    new Promise((resolve, reject) => {
      const check = () => {
        const found = records.find(predicate);
        if (found !== undefined) {
          listeners.delete(check);
          clearTimeout(timer);
          resolve(found);
          return true;
        }
        return false;
      };
      if (check()) return;
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(new Error(`timeout waiting for ${label}`));
      }, timeoutMs);
      listeners.add(check);
    });

  const onRecord = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const command = async (cmd, timeoutMs = 60_000) => {
    const id = send(cmd);
    return waitFor(
      (r) => r.type === "response" && r.id === id,
      timeoutMs,
      `response to ${cmd.type}`,
    );
  };

  const close = async (timeoutMs = 15_000) => {
    if (exited) return exitInfo;
    child.stdin.end();
    const deadline = Date.now() + timeoutMs;
    while (!exited && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!exited) {
      child.kill("SIGKILL");
      await new Promise((r) => setTimeout(r, 200));
    }
    return exitInfo ?? { code: null, signal: "still-running" };
  };

  return {
    child,
    records,
    stderr,
    send,
    command,
    waitFor,
    onRecord,
    close,
    get exited() {
      return exited;
    },
    get exitInfo() {
      return exitInfo;
    },
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Extract assistant text from message_end records, newest last. */
export function assistantTexts(records) {
  const texts = [];
  for (const record of records) {
    if (record.type !== "message_end") continue;
    const message = record.message ?? record;
    if (message?.role !== "assistant") continue;
    const text = (message.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    if (text.length > 0) texts.push(text);
  }
  return texts;
}

export function lastAssistantText(records) {
  const texts = assistantTexts(records);
  return texts.length > 0 ? texts[texts.length - 1] : null;
}
