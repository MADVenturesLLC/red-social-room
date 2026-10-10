// F14: browser check, then server check, before anything is sent. An upload lands in the content-addressed
// store as an asset; no provider call, no ledger row. The limits come from src/lib/upload-rules.ts (shared
// with the browser), and this route re-checks every one of them on its own.
import { getApp } from "../../../server/app.ts";
import { inspectImage } from "../../../../spike/lib/image.ts";
import { putImage, StoreError } from "../../../server/store.ts";
import { insertAsset } from "../../../server/execute.ts";
import { guardPost, json, readJson } from "../../../server/route-util.ts";
import { notWritableResponse } from "../../../server/writable.ts";
import { UPLOAD_MAX_BYTES, UPLOAD_MAX_SIDE } from "../../../lib/upload-rules.ts";

export const dynamic = "force-dynamic";

const B64_RE = /^[A-Za-z0-9+/=\r\n]+$/;

export async function POST(req: Request): Promise<Response> {
  const bad = guardPost(req); if (bad) return bad;
  const body = await readJson(req, 32 * 1024 * 1024); // a 20 MB image is ~27 MB as base64
  if (!body) return json({ error: "Expected a JSON object." }, 400);
  const raw = (body as Record<string, unknown>).data;
  if (typeof raw !== "string" || !raw) return json({ error: "No image data was sent." }, 400);
  const b64 = raw.startsWith("data:") ? raw.slice(raw.indexOf(",") + 1) : raw;
  if (!B64_RE.test(b64)) return json({ error: "The image data is not valid base64." }, 400);
  const buf = Buffer.from(b64, "base64");
  if (buf.length === 0) return json({ error: "No image data was sent." }, 400);
  if (buf.length > UPLOAD_MAX_BYTES) return json({ error: "That image is over 20 MB. Resize it and try again." }, 400);
  const info = inspectImage(buf);
  if (info.format === "unknown") return json({ error: "That file is not a PNG, JPEG or WebP image." }, 400);
  if ((info.width ?? 0) > UPLOAD_MAX_SIDE || (info.height ?? 0) > UPLOAD_MAX_SIDE) {
    return json({ error: "That image is larger than 8,000 px on a side. Resize it and try again." }, 400);
  }
  const app = getApp();
  const ro = notWritableResponse(app.dataDir); if (ro) return ro; // pin 19 (d): no write into a folder that is not writable
  try {
    const stored = putImage(app.imagesDir, buf);
    insertAsset(app.db, stored);
    return json({ assetId: stored.id, width: stored.width, height: stored.height, bytes: stored.bytes, mime: stored.mime });
  } catch (e) {
    if (e instanceof StoreError) return json({ error: e.message }, 500);
    return json({ error: "The upload failed inside the app." }, 500);
  }
}
