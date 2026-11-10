import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import { channelKinds, type ChannelConfigView } from "../../contracts/channel";
import { fail, ok, toAppError, type AppResult } from "../../contracts/result";
import { getRequestContext } from "../request-context";
import { toDomainAppError } from "./domain-errors";

const projectInput = z.strictObject({ projectId: z.string().min(1) });
async function channelBoundary<T>(
  headers: Headers,
  requestId: string,
  operation: (deps: Awaited<ReturnType<typeof serverDeps>>, humanId: string) => Promise<T> | T,
): Promise<AppResult<T>> {
  try {
    const deps = await serverDeps();
    const session = await deps.requireSession(headers, requestId);
    if (!session.ok) return session;
    deps.channel.assertChannelConfigHuman({ userId: session.data.userId, requestId });
    return ok(await operation(deps, session.data.userId), requestId);
  } catch (error) {
    const { ChannelConfigError } = await import("../../domain/channel-config");
    if (error instanceof ChannelConfigError)
      return fail({ code: error.code, message: error.message, requestId });
    const mapped = await toDomainAppError(error, requestId);
    return fail(mapped ?? toAppError(error, requestId));
  }
}
async function serverDeps() {
  const [authModule, channel, project] = await Promise.all([
    import("../session"),
    import("../../domain/channel-config"),
    import("../../domain/access"),
  ]);
  return { requireSession: authModule.requireSession, channel, project };
}

export function getChannelConfigsBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<AppResult<ChannelConfigView[]>> {
  return channelBoundary(headers, requestId, (deps, humanId) => {
    const { projectId } = projectInput.parse(raw);
    deps.project.assertProjectAccess({ userId: humanId, requestId }, projectId);
    return channelKinds.map((kind) =>
      deps.channel.toChannelConfigView(
        deps.channel.loadChannelConfigRow(projectId, kind),
        projectId,
        kind,
      ),
    );
  });
}

export function saveChannelConfigBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<AppResult<ChannelConfigView>> {
  return channelBoundary(headers, requestId, async (deps, humanId) => {
    const saved = deps.channel.saveChannelConfig(raw, humanId);
    await (await import("../runtime")).reloadChannelRuntime(saved.projectId);
    return saved;
  });
}

export const getChannelConfigsFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(({ data }) =>
    getChannelConfigsBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );
export const saveChannelConfigFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(({ data }) =>
    saveChannelConfigBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );
