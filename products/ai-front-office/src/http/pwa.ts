/**
 * The owner app as an installable web app, for call alerts on the phone (iPhone needs Add to Home Screen first).
 * The service worker only shows pushes and opens the call on tap. It has no fetch handler and caches nothing,
 * so the app shell, the API and sign-in work exactly as before.
 */
export const SERVICE_WORKER = `"use strict";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (error) { data = {}; }
  const url = typeof data.url === "string" && data.url.startsWith("/app") ? data.url : "/app";
  event.waitUntil(self.registration.showNotification(data.title || "Call Otto", {
    body: data.body || "",
    tag: data.tag || undefined,
    renotify: Boolean(data.tag),
    requireInteraction: data.urgent === true,
    icon: "/assets/icon-192.png",
    badge: "/assets/icon-192.png",
    data: { url },
  }));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || "/app", self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (client.url.startsWith(self.location.origin + "/app") && "navigate" in client) {
        const moved = await client.navigate(target).catch(() => null);
        if (moved) {
          await moved.focus();
          return;
        }
      }
    }
    await self.clients.openWindow(target);
  })());
});
`;

export const WEB_MANIFEST = JSON.stringify({
  name: "Call Otto",
  short_name: "Call Otto",
  description: "Who called, and who's waiting on you.",
  id: "/app",
  start_url: "/app",
  scope: "/app",
  display: "standalone",
  background_color: "#faf8f1",
  theme_color: "#faf8f1",
  icons: [
    { src: "/assets/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "/assets/icon-512.png", sizes: "512x512", type: "image/png" },
    { src: "/assets/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
});
