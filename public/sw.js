// C1: the minimal service worker the install prompt needs. It never caches app data or API responses —
// the room is a live tool, and a stale ledger or library would be worse than being offline. Navigations
// fall back to a plain offline line when the network is gone; everything else goes straight to the net.
self.addEventListener("install", () => { self.skipWaiting(); });
self.addEventListener("activate", (event) => { event.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return; // never intercept POSTs (runs, saves, caps)
  event.respondWith(
    fetch(event.request).catch(() =>
      new Response("Offline. Open Red Social Room again when the connection is back.", {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      })
    )
  );
});
