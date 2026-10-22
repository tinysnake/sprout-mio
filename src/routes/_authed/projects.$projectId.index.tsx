import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authed/projects/$projectId/")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/projects/$projectId/chats", params: { projectId: params.projectId } });
  },
});
