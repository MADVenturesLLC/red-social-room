"use client";
// B1: the header chip. Fetches who the request belongs to (the server reads the Cloudflare Access header);
// the same answer drives the spend controls in CreateClient. No login of its own.
import { useEffect, useState } from "react";

export interface WhoAmI { name: string; role: string | null; email: string | null; canSpend: boolean; isOwner: boolean; via: "access" | "local" | "unknown" }

export async function fetchWhoAmI(): Promise<WhoAmI | null> {
  try {
    const r = await fetch("/api/whoami", { cache: "no-store" });
    if (!r.ok) return null;
    return (await r.json()) as WhoAmI;
  } catch {
    return null;
  }
}

export default function WhoAmIChip() {
  const [me, setMe] = useState<WhoAmI | null>(null);
  useEffect(() => { void fetchWhoAmI().then(setMe); }, []);
  if (!me) return <span className="who" data-testid="actor" data-view-only="0"> </span>;
  const label = me.name + (me.role ? ` (${me.role})` : "");
  return (
    <span className="who" data-testid="actor" data-view-only={me.canSpend ? "0" : "1"}>
      {me.canSpend ? "Signed in as" : "View only"} — {label}
    </span>
  );
}
