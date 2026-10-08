// Helpers for route handlers: JSON responses that are never cached, and a same-origin guard for POSTs.
// The app is tailnet-only with no login, so a cross-site page must not be able to make it spend money:
// every POST must carry the custom header x-rsr: 1 and a JSON content type (a cross-origin page cannot
// send that without a CORS preflight, which this app never approves), and Sec-Fetch-Site must not be cross-site.
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}

export function guardPost(req: Request): Response | null {
  if (req.headers.get("x-rsr") !== "1") return json({ error: "Missing x-rsr header." }, 403);
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return json({ error: "Expected JSON." }, 415);
  if (req.headers.get("sec-fetch-site") === "cross-site") return json({ error: "Cross-site request refused." }, 403);
  return null;
}

export async function readJson(req: Request, maxBytes = 64 * 1024): Promise<Record<string, unknown> | null> {
  const t = await req.text();
  if (t.length > maxBytes) return null;
  try { const v = JSON.parse(t); return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null; } catch { return null; }
}
