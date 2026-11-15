import { createFileRoute } from "@tanstack/react-router";
import { listWorkspaceBoundary } from "../../../server/functions/workspace";
import { getRequestContext, REQUEST_ID_HEADER } from "../../../server/request-context";

export async function workspaceTreeResponse(request: Request): Promise<Response> {
  const { requestId } = getRequestContext(request);
  const url = new URL(request.url);
  const result = await listWorkspaceBoundary(
    {
      projectId: url.searchParams.get("projectId") ?? "",
      ...(url.searchParams.get("chatId")
        ? { chatId: url.searchParams.get("chatId") as string }
        : {}),
      path: url.searchParams.get("path") ?? "",
    },
    request.headers,
    requestId,
  );
  return Response.json(result, {
    headers: { [REQUEST_ID_HEADER]: requestId, "cache-control": "private, no-store" },
  });
}

export const Route = createFileRoute("/api/workspace/tree")({
  server: { handlers: { GET: ({ request }) => workspaceTreeResponse(request) } },
});
