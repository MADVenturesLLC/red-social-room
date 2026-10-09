// Browser-side POST helper: JSON + the x-rsr header the server requires (src/server/route-util.ts guardPost).
export async function postJson<T>(url: string, body: unknown): Promise<{ ok: boolean; status: number; data: T | null }> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "x-rsr": "1" }, body: JSON.stringify(body) });
    let data: T | null = null;
    try { data = (await res.json()) as T; } catch { data = null; }
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}
