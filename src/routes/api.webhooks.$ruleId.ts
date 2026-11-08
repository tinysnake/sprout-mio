import { createFileRoute } from "@tanstack/react-router";
import { appIdPattern, ID_PREFIXES } from "../contracts/ids";

const rulePattern = new RegExp(appIdPattern(ID_PREFIXES.webhookRule));
const MAX_BYTES = 64 * 1024;
function response(status: number, error?: string) {
  return Response.json(error ? { error } : { ok: true }, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
export async function webhookPost(request: Request, ruleId: string): Promise<Response> {
  if (!rulePattern.test(ruleId)) return response(404, "not_found");
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9_-]{40,64})$/.exec(authorization);
  if (!match) return response(401, "unauthorized");
  const { assertWebhookCredential, AutomationError } = await import("../domain/automation");
  try {
    assertWebhookCredential(ruleId, match[1]);
  } catch (error) {
    if (error instanceof AutomationError && error.code === "unauthorized")
      return response(401, "unauthorized");
    return response(503, "temporarily_unavailable");
  }
  const eventId = request.headers.get("x-sprout-event-id");
  if (!eventId || eventId.length > 200 || !eventId.trim()) return response(400, "invalid_event_id");
  if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get("content-type") ?? ""))
    return response(415, "unsupported_media_type");
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES))
    return response(413, "payload_too_large");
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  const reader = request.body?.getReader();
  if (!reader) return response(400, "invalid_json");
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) {
        await reader.cancel();
        return response(413, "payload_too_large");
      }
      chunks.push(value);
    }
    const body = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    const payload: unknown = JSON.parse(body);
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      return response(400, "object_required");
    const { receiveWebhook } = await import("../domain/automation");
    const receipt = receiveWebhook(ruleId, match[1], eventId, payload);
    return Response.json(receipt, { status: 200, headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError)
      return response(400, "invalid_json");
    if (error && typeof error === "object" && "code" in error) {
      const code = String((error as { code: unknown }).code);
      if (code === "unauthorized") return response(401, "unauthorized");
      if (code === "conflict") return response(409, "event_conflict");
    }
    return response(503, "temporarily_unavailable");
  }
}
export const Route = createFileRoute("/api/webhooks/$ruleId")({
  server: { handlers: { POST: ({ request, params }) => webhookPost(request, params.ruleId) } },
});
