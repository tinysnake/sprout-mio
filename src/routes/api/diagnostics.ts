import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { fail, ok, toAppError } from "../../contracts/result";
import { queryDiagnostics, queryManagementSummary } from "../../server/diagnostics";
import { getRequestContext, REQUEST_ID_HEADER } from "../../server/request-context";
import { runtimeReady } from "../../server/runtime";
import { requireSession } from "../../server/session";

const filters = z
  .object({
    requestId: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .refine((value) => value.requestId !== undefined || value.projectId !== undefined, {
    message: "必须提供 requestId 或 projectId",
  });

export async function diagnosticsResponse(request: Request): Promise<Response> {
  const { requestId } = getRequestContext(request);
  const headers = { [REQUEST_ID_HEADER]: requestId, "cache-control": "no-store" };
  try {
    await runtimeReady;
    const session = await requireSession(request.headers, requestId);
    if (!session.ok) return Response.json(session, { status: 401, headers });
    const params = new URL(request.url).searchParams;
    if (params.get("summary") === "1")
      return Response.json(ok(queryManagementSummary(session.data.userId), requestId), { headers });
    const query = filters.safeParse(Object.fromEntries(params));
    if (!query.success) {
      return Response.json(fail(toAppError(query.error, requestId)), { status: 400, headers });
    }
    return Response.json(
      ok(queryDiagnostics({ ...query.data, actorId: session.data.userId }), requestId),
      { headers },
    );
  } catch (error) {
    return Response.json(fail(toAppError(error, requestId)), { status: 500, headers });
  }
}

export const Route = createFileRoute("/api/diagnostics")({
  server: { handlers: { GET: ({ request }) => diagnosticsResponse(request) } },
});
