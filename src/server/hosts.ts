// A1 pin 17, line 368 (Amendment 1 at 5c773d7): every request - pages, API routes, static files - checks the Host
// header before anything else (DNS-rebinding guard; Argus M2 on fa3d359). The host name is compared without its
// port and without regard to case. Allowed by default: localhost, 127.0.0.1, [::1]; RSR_ALLOWED_HOSTS adds more
// names, comma-separated, spaces trimmed. An empty or unlisted Host (or a missing one that reaches the app, as
// HTTP/1.0 allows) -> 403 with a fixed JSON body that does not echo the header. An HTTP/1.1 request with no Host
// line gets Node's own 400 before the app runs, which the pin allows. X-Forwarded-Host is never read.
// No Node-only imports: this runs inside src/proxy.ts too.

export const DEFAULT_ALLOWED_HOSTS: readonly string[] = Object.freeze(["localhost", "127.0.0.1", "[::1]"]);
export const HOST_REFUSED_BODY = JSON.stringify({ error: "Host not allowed." });

/**
 * The host name of a Host header value, lowercased, without its port. A bracketed IPv6 literal keeps its
 * brackets ("[::1]:3000" -> "[::1]"). Returns null for anything that is not a plain host[:port].
 */
export function hostName(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (!v) return null;
  let name: string, rest: string;
  if (v.startsWith("[")) {
    const end = v.indexOf("]");
    if (end < 0) return null;
    name = v.slice(0, end + 1); rest = v.slice(end + 1);
    if (!/^\[[0-9a-f:.]+\]$/.test(name)) return null;
  } else {
    const i = v.indexOf(":");
    name = i < 0 ? v : v.slice(0, i); rest = i < 0 ? "" : v.slice(i);
    if (!/^[a-z0-9.-]+$/.test(name)) return null;
  }
  if (rest !== "" && !/^:\d{1,5}$/.test(rest)) return null;
  return name;
}

/** The allowlist: the defaults plus RSR_ALLOWED_HOSTS (comma-separated, spaces trimmed, ports and case ignored). */
export function allowedHosts(envValue: string | undefined): Set<string> {
  const out = new Set<string>(DEFAULT_ALLOWED_HOSTS);
  for (const raw of (envValue ?? "").split(",")) {
    const n = hostName(raw);
    if (n) out.add(n);
  }
  return out;
}

export function hostAllowed(hostHeader: string | null | undefined, envValue: string | undefined): boolean {
  const n = hostName(hostHeader);
  return n !== null && allowedHosts(envValue).has(n);
}

/** 403 for a refused Host (fixed body; never echoes the header), or null when the Host is allowed. */
export function hostGuard(req: Request, envValue: string | undefined = process.env.RSR_ALLOWED_HOSTS): Response | null {
  if (hostAllowed(req.headers.get("host"), envValue)) return null;
  return new Response(HOST_REFUSED_BODY, { status: 403, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}
