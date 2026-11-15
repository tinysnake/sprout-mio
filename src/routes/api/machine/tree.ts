import { createFileRoute } from "@tanstack/react-router";
import { listMachineTreeBoundary } from "../../../server/functions/machine-browse";
import { getRequestContext, REQUEST_ID_HEADER } from "../../../server/request-context";

const STATUS_BY_CODE: Record<string, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 400,
  conflict: 409,
};

export async function machineTreeResponse(request: Request): Promise<Response> {
  const { requestId } = getRequestContext(request);
  const url = new URL(request.url);
  const result = await listMachineTreeBoundary(
    {
      projectId: url.searchParams.get("projectId") ?? "",
      machineId: url.searchParams.get("machineId") ?? "",
      path: url.searchParams.get("path") ?? "",
    },
    request.headers,
    requestId,
  );
  return Response.json(
    result.ok ? { ok: true, data: { root: "machine", ...result.data }, requestId } : result,
    {
      status: result.ok ? 200 : (STATUS_BY_CODE[result.error.code] ?? 500),
      headers: { [REQUEST_ID_HEADER]: requestId, "cache-control": "private, no-store" },
    },
  );
}

export const Route = createFileRoute("/api/machine/tree")({
  server: { handlers: { GET: ({ request }) => machineTreeResponse(request) } },
});
