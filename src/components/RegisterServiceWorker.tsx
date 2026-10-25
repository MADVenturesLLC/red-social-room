"use client";
// C1: register the service worker so the app can be installed to the home screen. Only on https (the
// Cloudflare door and the tailnet URL); a plain-http dev server has no service workers.
import { useEffect } from "react";

export default function RegisterServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator) || location.protocol !== "https:") return;
    void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }, []);
  return null;
}
