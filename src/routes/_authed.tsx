import { Outlet, createFileRoute, redirect, useLocation, useRouter } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { AppShell, projectCreationFocusTarget } from "../components/layout/app-shell";
import { ProjectFormDialog } from "../components/project/project-form-dialog";
import { ResultError } from "../components/project/result-error";
import { authenticate, getProtectedSession } from "../server/session";
import { createProjectFn, listProjectsFn } from "../server/functions/project";

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
  const [creationOpen, setCreationOpen] = useState(false);
  const creationOpener = useRef<HTMLElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const projectId = location.pathname.match(/^\/projects\/([^/]+)/)?.[1];
  const inspectorOpen =
    /^\/projects\/[^/]+\/chats\/[^/]+$/.test(location.pathname) &&
    new URLSearchParams(location.searchStr).get("info") === "1";

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
      onCreateProject={() => {
        creationOpener.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setCreationOpen(true);
      }}
    >
      <ProjectFormDialog
        open={creationOpen}
        onOpenChange={setCreationOpen}
        finalFocus={() => projectCreationFocusTarget(creationOpener.current)}
        submit={(values) => createProjectFn({ data: values })}
        onCreated={async (project) => {
          await router.invalidate({ sync: true });
          await router.navigate({
            to: "/projects/$projectId/chats",
            params: { projectId: project.id },
          });
        }}
      />
      {!projects.ok && (
        <div className="shrink-0 p-4">
          <ResultError error={projects.error} testId="shell-projects-error" />
        </div>
      )}
      <Outlet />
    </AppShell>
  );
}
