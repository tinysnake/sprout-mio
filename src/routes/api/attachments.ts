import { createFileRoute } from "@tanstack/react-router";
import { uploadMessageAttachmentsBoundary } from "../../server/functions/attachment";
import { getRequestContext, REQUEST_ID_HEADER } from "../../server/request-context";

export async function attachmentsUploadResponse(request: Request): Promise<Response> {
  const { requestId } = getRequestContext(request);
  const result = await uploadMessageAttachmentsBoundary(request, requestId);
  return Response.json(result, {
    headers: { [REQUEST_ID_HEADER]: requestId, "cache-control": "no-store" },
  });
}

export const Route = createFileRoute("/api/attachments")({
  server: { handlers: { POST: ({ request }) => attachmentsUploadResponse(request) } },
});
