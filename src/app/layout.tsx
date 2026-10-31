import type { ReactNode } from "react";
import { getApp } from "../server/app.ts";
import { unresolvedRows } from "../server/ledger.ts";
import WhoAmIChip from "../components/WhoAmIChip.tsx";
import RegisterServiceWorker from "../components/RegisterServiceWorker.tsx";
import "./globals.css";
import "./fonts.css";

export const metadata = {
  title: "Red Social Room",
  robots: { index: false, follow: false },
  // C1: installable app — manifest + icons let it live on the home screen like a native app.
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: { capable: true, title: "Red Social Room", statusBarStyle: "black-translucent" },
};
export const viewport = { width: "device-width", initialScale: 1, themeColor: "#0b0b0f", viewportFit: "cover" };

export default function RootLayout({ children }: { children: ReactNode }) {
  // F21: a badge on the Spend link shows the count of rows whose cost is still unknown.
  const unresolved = unresolvedRows(getApp().db).length;
  return (
    <html lang="en">
      <body>
        <header>
          <strong>Red Social Room</strong>
          <a href="/">Create</a>
          <a href="/library">Library</a>
          <a href="/settings">Settings{unresolved > 0 ? <> <span className="badge" data-testid="spend-badge">{unresolved}</span></> : null}</a>
          <WhoAmIChip />
        </header>
        <main>{children}</main>
        <RegisterServiceWorker />
      </body>
    </html>
  );
}
