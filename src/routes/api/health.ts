import { createFileRoute } from "@tanstack/react-router";
import { getRequestContext, REQUEST_ID_HEADER } from "../../server/request-context";
import { databaseHealth, runtimeSnapshot } from "../../server/runtime";

export function healthResponse(request: Request): Response {
  const { requestId } = getRequestContext(request);
  const snapshot = runtimeSnapshot();
  const database = databaseHealth();
  const ok = snapshot.ready && database.ok && database.migrationApplied;
  return Response.json(
    {
      ok,
      ready: snapshot.ready,
      phase: snapshot.phase,
      bootId: snapshot.bootId,
      requestId,
      version: snapshot.version,
      database,
    },
    {
      status: ok ? 200 : 503,
      headers: { [REQUEST_ID_HEADER]: requestId, "cache-control": "no-store" },
    },
  );
}

export const Route = createFileRoute("/api/health")({
  server: { handlers: { GET: ({ request }) => healthResponse(request) } },
});
