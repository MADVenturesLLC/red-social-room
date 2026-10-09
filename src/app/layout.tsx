import type { ReactNode } from "react";
import "./globals.css";

export const metadata = { title: "Red Social Room", robots: { index: false, follow: false } };
export const viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header>
          <strong>Red Social Room</strong>
          <a href="/">Create</a>
          <a href="/library">Library</a>
          <a href="/settings">Settings</a>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
