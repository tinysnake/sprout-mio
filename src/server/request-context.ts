import { getRequestHeader } from "@tanstack/react-start/server";
import { ID_PREFIXES, newId } from "../contracts/ids";

export const REQUEST_ID_HEADER = "x-sprout-request-id";
export type RequestContext = { requestId: string };

export function initializeRequestContext(request: Request): RequestContext {
  const context = { requestId: newId(ID_PREFIXES.request) };
  request.headers.set(REQUEST_ID_HEADER, context.requestId);
  return context;
}

export function getRequestContext(request?: Request): RequestContext {
  const requestId = request
    ? request.headers.get(REQUEST_ID_HEADER)
    : getRequestHeader(REQUEST_ID_HEADER);
  if (!requestId) throw new Error("请求尚未经过 requestId 边界");
  return { requestId };
}
