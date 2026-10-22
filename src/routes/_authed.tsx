import { Outlet, createFileRoute, redirect, useLocation, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { AppShell } from "../components/layout/app-shell";
import { CreateProjectDialog } from "../components/project/create-project-dialog";
import { ResultError } from "../components/project/result-error";
import { authenticate, getProtectedSession } from "../server/session";
import { listProjectsFn } from "../server/functions/project";

export const Route = createFileRoute("/_authed")({
  beforeLoad: async () => {
    if (import.meta.env.SSR) return { human: null };
    const result = await getProtectedSession();
    if (!result.ok) {
      if (result.error.code === "unauthorized") throw redirect({ to: "/login" });
      throw new Error(result.error.message);
    }
    return { human: result.data };
  },
  loader: () => listProjectsFn(),
  component: AuthedLayout,
});

function AuthedLayout() {
  const { human } = Route.useRouteContext();
  const projects = Route.useLoaderData();
  const router = useRouter();
  const location = useLocation();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const projectId = location.pathname.match(/^\/projects\/([^/]+)/)?.[1];
  const inspectorOpen = new URLSearchParams(location.searchStr).get("info") === "1";

  async function signOut() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await authenticate({ data: { action: "logout" } });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      await router.invalidate();
      await router.navigate({ to: "/login" });
    } catch {
      setError("登出失败，请重试");
    } finally {
      setPending(false);
    }
  }

  if (!human) return null;
  return (
    <AppShell
      projects={projects.ok ? projects.data : []}
      projectId={projectId}
      pathname={location.pathname}
      inspectorOpen={inspectorOpen}
      name={human.name}
      email={human.email}
      pending={pending}
      onSignOut={() => void signOut()}
      signOutError={error}
      createProjectAction={
        <CreateProjectDialog
          onCreated={async (project) => {
            await router.invalidate();
            await router.navigate({
              to: "/projects/$projectId/chats",
              params: { projectId: project.id },
            });
          }}
        />
      }
    >
      {!projects.ok && (
        <div className="shrink-0 p-4">
          <ResultError error={projects.error} testId="projects-error" />
        </div>
      )}
      <Outlet />
    </AppShell>
  );
}
