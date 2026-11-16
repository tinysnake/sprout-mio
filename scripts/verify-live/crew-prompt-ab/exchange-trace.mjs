import { IncomingMessage, ServerResponse } from "node:http";
import { appendFileSync } from "node:fs";

const log = process.env.AB_EXCHANGE_LOG;
const requests = new WeakMap();
const responses = new WeakMap();
const relevant = (request) =>
  /^\/api\/(remote\/agent|worker\/exchange)(?:\?|$)/.test(request?.url ?? "");
const scrub = (value) => {
  if (Array.isArray(value)) return value.map(scrub);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      /token|secret|ticket|credential|^authorization$/i.test(key) ? "[redacted]" : scrub(item),
    ]),
  );
};
const decode = (chunks) => {
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return scrub(JSON.parse(text));
  } catch {
    return text.slice(0, 4096);
  }
};
const chunkBuffer = (chunk, encoding) =>
  Buffer.isBuffer(chunk)
    ? chunk
    : Buffer.from(chunk, typeof encoding === "string" ? encoding : undefined);

if (log) {
  const emit = IncomingMessage.prototype.emit;
  IncomingMessage.prototype.emit = function (event, ...args) {
    if (event === "data" && relevant(this)) {
      const chunks = requests.get(this) ?? [];
      chunks.push(chunkBuffer(args[0]));
      requests.set(this, chunks);
    }
    return emit.call(this, event, ...args);
  };
  const write = ServerResponse.prototype.write;
  const end = ServerResponse.prototype.end;
  ServerResponse.prototype.write = function (chunk, encoding, ...rest) {
    if (chunk && relevant(this.req)) {
      const chunks = responses.get(this) ?? [];
      chunks.push(chunkBuffer(chunk, encoding));
      responses.set(this, chunks);
    }
    return write.call(this, chunk, encoding, ...rest);
  };
  ServerResponse.prototype.end = function (chunk, encoding, ...rest) {
    if (relevant(this.req)) {
      const chunks = responses.get(this) ?? [];
      if (chunk && typeof chunk !== "function") chunks.push(chunkBuffer(chunk, encoding));
      const entry = {
        at: new Date().toISOString(),
        path: this.req.url,
        status: this.statusCode,
        request: decode(requests.get(this.req) ?? []),
        response: decode(chunks),
      };
      // Empty long-poll exchanges carry no diagnostic evidence. Keep errors and work.
      if (
        !this.req.url.includes("worker/exchange") ||
        this.statusCode !== 200 ||
        chunks.some((c) => /dispatch|execution|accessible|error/.test(c.toString()))
      )
        appendFileSync(log, JSON.stringify(entry) + "\n", { mode: 0o600 });
    }
    return end.call(this, chunk, encoding, ...rest);
  };
}
