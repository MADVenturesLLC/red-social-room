// A6: the ZIP — one exact-size image per ticked platform plus captions.txt (T:101). Missing renditions
// stop the export with the platform named; nothing is silently replaced.
import { getApp } from "../../../server/app.ts";
import { exportZip, RenditionError } from "../../../server/renditions.ts";
import { guardPost, json, readJson } from "../../../server/route-util.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request): Promise<Response> {
  const bad = guardPost(req); if (bad) return bad;
  const body = await readJson(req);
  if (!body) return json({ error: "Expected a JSON object." }, 400);
  const app = getApp();
  try {
    const { buf, filename } = await exportZip(app.db, app.imagesDir, body.postId, body.presets);
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    if (e instanceof RenditionError) return json({ error: e.message }, 400);
    app.log?.(`export failed: ${(e as Error).name}: ${(e as Error).message}`);
    return json({ error: "The export did not build inside the app." }, 500);
  }
}
