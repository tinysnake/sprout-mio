import { createFileRoute } from "@tanstack/react-router";
import { APP_VERSION } from "../contracts/version";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center px-6 py-16">
      <p className="text-sm text-muted-foreground">版本 {APP_VERSION}</p>
      <h1 className="mt-3 text-4xl font-semibold tracking-tight">Sprout Mio</h1>
      <p className="mt-6 text-base text-muted-foreground">应用入口已就绪。</p>
    </main>
  );
}
