import { createFileRoute } from "@tanstack/react-router";
import { ContinuationDiagnosticPage } from "../../components/continuation/continuation-diagnostic-page";

export const Route = createFileRoute(
  "/_authed/projects/$projectId/chats/$chatId/checks/$evaluationId/wake",
)({ component: DiagnosticRoute });

function DiagnosticRoute() {
  const { evaluationId } = Route.useParams();
  return <ContinuationDiagnosticPage evaluationId={evaluationId} kind="wake" />;
}
