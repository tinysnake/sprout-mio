import { createFileRoute } from "@tanstack/react-router";
import { readMachineFileBoundary } from "../../../server/functions/machine-browse";
import { MachineFileTooLargeError, MachineRangeError } from "../../../server/machine-browse";
import { getRequestContext, REQUEST_ID_HEADER } from "../../../server/request-context";

const STATUS_BY_CODE: Record<string, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 400,
  conflict: 409,
};

/**
 * 远端机器上的 HTML/SVG 同样是别人写的脚本：加 `sandbox` 之后浏览器用独立源渲染，
 * 拿不到 app 的 cookie，也不会有同源接口可打。
 */
const SANDBOXED_CSP =
  "sandbox; default-src 'none'; img-src data: blob:; media-src data: blob:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'none'; base-uri 'none'";

export async function machineFileResponse(request: Request): Promise<Response> {
  const { requestId } = getRequestContext(request);
  const url = new URL(request.url);
  const result = await readMachineFileBoundary(
    {
      projectId: url.searchParams.get("projectId") ?? "",
      machineId: url.searchParams.get("machineId") ?? "",
      path: url.searchParams.get("path") ?? "",
    },
    request.headers,
    requestId,
    request.headers.get("range"),
  );
  if (!result.ok)
    return Response.json(result, {
      status: STATUS_BY_CODE[result.error.code] ?? 500,
      headers: { [REQUEST_ID_HEADER]: requestId, "cache-control": "private, no-store" },
    });
  const file = result.data;
  const sandboxed =
    file.contentType.startsWith("text/html") || file.contentType === "image/svg+xml";
  return new Response(file.body as BodyInit, {
    status: file.status,
    headers: {
      [REQUEST_ID_HEADER]: requestId,
      "content-type": file.contentType,
      "content-length": String(file.length),
      "cache-control": "private, no-cache",
      "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      "x-content-type-options": "nosniff",
      "accept-ranges": "bytes",
      ...(file.contentRange ? { "content-range": file.contentRange } : {}),
      ...(sandboxed ? { "content-security-policy": SANDBOXED_CSP } : {}),
    },
  });
}

/** 越界与超限不是错误码，而是 HTTP 语义：416 带总量，413 带上限。 */
export function machineFileFailureResponse(
  error: unknown,
  requestId: string,
): Response | undefined {
  if (error instanceof MachineRangeError)
    return new Response(null, {
      status: 416,
      headers: {
        [REQUEST_ID_HEADER]: requestId,
        "content-range": `bytes */${error.totalSize}`,
        "cache-control": "private, no-store",
      },
    });
  if (error instanceof MachineFileTooLargeError)
    return Response.json(
      { ok: false, error: { code: "validation_failed", message: error.message, requestId } },
      {
        status: 413,
        headers: { [REQUEST_ID_HEADER]: requestId, "cache-control": "private, no-store" },
      },
    );
  return undefined;
}

export const Route = createFileRoute("/api/machine/file")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { requestId } = getRequestContext(request);
        try {
          return await machineFileResponse(request);
        } catch (error) {
          const handled = machineFileFailureResponse(error, requestId);
          if (handled) return handled;
          throw error;
        }
      },
    },
  },
});
