import { useRouter } from "@tanstack/react-router";
import { Route as ChatRoute } from "../../routes/_authed/projects.$projectId.chats.$chatId";
import { isActiveRunState, useChatLive } from "../chat/use-chat-live";
import { sessionDisplayTitle } from "../chat/chat-session-display";
import { ResultError } from "../project/result-error";
import { controlChatContinuationFn } from "../../server/functions/chat-continuation";
import { requestRouteReload } from "../../lib/route-reload";
import { ContinuationDiagnostic } from "./continuation-diagnostic";
import type { ContinuationDenial, ContinuationSubmit } from "./continuation-page-data";

export function ContinuationDiagnosticPage({
  evaluationId,
  kind,
}: {
  evaluationId: string;
  kind: "wake" | "continuation";
}) {
  const loader = ChatRoute.useLoaderData();
  const { projectId, chatId } = ChatRoute.useParams();
  const router = useRouter();
  const facts = useChatLive({
    chatId,
    projectId,
    active: loader.ok && isActiveRunState(loader.runState),
    loader,
    onRunChanged: () => void requestRouteReload(router),
  });
  const submit: ContinuationSubmit = async (command) => {
    const result = await controlChatContinuationFn({ data: command });
    if (!result.ok)
      return {
        ok: false,
        error: {
          code: result.error.code as ContinuationDenial["code"],
          reason: result.error.message,
          requestId: result.requestId,
        },
      };
    await router.invalidate();
    return { ok: true, data: { view: result.data.view, denials: result.data.denials } };
  };
  if (!loader.ok) return <ResultError error={loader.error} testId="diagnostic-chat-error" />;
  const continuation = facts?.continuation ?? loader.continuation;
  if (!continuation.ok)
    return <ResultError error={continuation.error} testId="diagnostic-read-error" />;
  return (
    <ContinuationDiagnostic
      key={`${chatId}:${evaluationId}:${kind}`}
      data={continuation.data}
      evaluationId={evaluationId}
      kind={kind}
      chatTitle={sessionDisplayTitle(loader.session, loader.info.ok ? loader.info.data : undefined)}
      onCommand={submit}
    />
  );
}
