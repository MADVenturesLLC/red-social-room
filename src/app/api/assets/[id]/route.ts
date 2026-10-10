// Serves a stored image by its SHA-256 id. The path is built from the validated id and the stored
// extension only, never from user text, so it cannot leave the images folder.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getApp } from "../../../../server/app.ts";
import { SHA_RE, relPathFor } from "../../../../server/store.ts";

export const dynamic = "force-dynamic";

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/svg+xml": "svg" };

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  if (!SHA_RE.test(id)) return new Response("Not found", { status: 404 });
  const app = getApp();
  const a = app.db.prepare("SELECT mime FROM assets WHERE id = ?").get(id) as { mime: string } | undefined;
  if (!a || !EXT[a.mime]) return new Response("Not found", { status: 404 });
  try {
    const buf = await readFile(join(app.imagesDir, relPathFor(id, EXT[a.mime])));
    const headers: Record<string, string> = { "Content-Type": a.mime, "Cache-Control": "private, max-age=31536000, immutable" };
    // A4: an SVG logo is drawn in <img>/canvas contexts where scripts never run; this policy also covers
    // someone opening the asset URL directly (a sandboxed document runs no script).
    if (a.mime === "image/svg+xml") headers["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
    return new Response(new Uint8Array(buf), { headers });
  } catch {
    return new Response("Image file missing", { status: 404 });
  }
}
