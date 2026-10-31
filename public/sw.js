/* Read-only offline support. Writes are never queued or replayed. */
const SHELL = "sprout-shell-v1";
const READS = "sprout-reads-v1";
let readManifest;
async function readFunctions() {
  readManifest ??= (async () => {
    const response = await (await caches.open(SHELL)).match("/pwa-reads.json");
    return response ? response.json() : {};
  })();
  return readManifest;
}
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const response = await fetch("/pwa-assets.json", { cache: "no-store" });
      const assets = await response.json();
      const cache = await caches.open(SHELL);
      await cache.addAll([
        "/",
        "/manifest.webmanifest",
        "/pwa-reads.json",
        "/icons/icon-192.png",
        "/icons/icon-512.png",
        ...assets,
      ]);
      await self.skipWaiting();
    })(),
  );
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys())
        if (name.startsWith("sprout-") && ![SHELL, READS].includes(name)) await caches.delete(name);
      await self.clients.claim();
    })(),
  );
});
async function readKey(request) {
  if (request.method === "GET") return request;
  const bytes = new TextEncoder().encode(request.url + "\n" + (await request.clone().text()));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const key = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  return new Request(new URL("/__offline-read/" + key, self.location.origin));
}
async function cachedRead(request) {
  const cache = await caches.open(READS);
  const key = await readKey(request);
  try {
    const response = await fetch(request);
    if (response.status === 401 || response.status === 403) await caches.delete(READS);
    else if (response.ok) {
      const text = await response.clone().text();
      if (/"code"\s*:\s*"(?:unauthorized|forbidden)"/.test(text)) await caches.delete(READS);
      else {
        const headers = new Headers(response.headers);
        headers.set("x-sprout-cached-at", new Date().toISOString());
        await cache.put(key, new Response(text, { status: response.status, headers }));
      }
    }
    return response;
  } catch (cause) {
    const saved = await cache.match(key);
    if (!saved) throw cause;
    const headers = new Headers(saved.headers);
    headers.set("x-sprout-offline", "1");
    return new Response(await saved.arrayBuffer(), { status: saved.status, headers });
  }
}
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.method !== "GET") {
    event.respondWith(
      (async () => {
        const id = url.pathname.split("/_serverFn/")[1];
        if (id && (await readFunctions())[id]) return cachedRead(request);
        // A confirmed mutation, including login/logout, invalidates prior-identity reads.
        const response = await fetch(request);
        if (response.ok) await caches.delete(READS);
        return response;
      })(),
    );
    return;
  }
  if (
    request.mode === "navigate" &&
    !url.pathname.startsWith("/api/") &&
    !url.pathname.startsWith("/_serverFn/")
  ) {
    event.respondWith(
      fetch(request).catch(async () =>
        (await caches.open(SHELL)).match("/").then((saved) => saved || Response.error()),
      ),
    );
  } else if (
    url.pathname.startsWith("/assets/") ||
    url.pathname.startsWith("/icons/") ||
    ["/manifest.webmanifest", "/pwa-reads.json"].includes(url.pathname)
  ) {
    event.respondWith(caches.match(request).then((saved) => saved || fetch(request)));
  } else if (
    url.pathname.startsWith("/_serverFn/") ||
    url.pathname === "/api/health" ||
    (url.pathname === "/api/diagnostics" && url.searchParams.get("summary") === "1")
  ) {
    event.respondWith(cachedRead(request));
  }
});
