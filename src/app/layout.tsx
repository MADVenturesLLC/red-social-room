import type { ReactNode } from "react";
import { getApp } from "../server/app.ts";
import { unresolvedRows } from "../server/ledger.ts";
import WhoAmIChip from "../components/WhoAmIChip.tsx";
import "./globals.css";
import "./fonts.css";

export const metadata = { title: "Red Social Room", robots: { index: false, follow: false } };
export const viewport = { width: "device-width", initialScale: 1 };

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
      </body>
    </html>
  );
}
