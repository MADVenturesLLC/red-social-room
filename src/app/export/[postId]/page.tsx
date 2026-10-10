// A6: platform sizing + export (TECH-PLAN-v1.md :218-220). Server component: the post's final image,
// its renditions, the size presets from config and the P3 switch.
import { notFound } from "next/navigation";
import { getApp } from "../../../server/app.ts";
import { getPostDesign } from "../../../server/design.ts";
import { listRenditions, loadSizes } from "../../../server/renditions.ts";
import ExportClient from "../../../components/ExportClient.tsx";

export const dynamic = "force-dynamic";

export default async function ExportPage({ params }: { params: Promise<{ postId: string }> }) {
  const { postId } = await params;
  const app = getApp();
  const post = getPostDesign(app.db, postId);
  if (!post || !post.width || !post.height) notFound();
  return (
    <>
      <h1>Export <span className="muted mini">{post.prompt}</span></h1>
      <p className="muted">Every image here is made at its platform’s exact pixel size (smart crop to start; drag the frame if the subject sits elsewhere). “AI extend” widens with Nano Banana 2 — one paid edit — and lands back on the same exact size. The ZIP carries one image per platform plus a captions.txt.</p>
      <ExportClient
        post={{ id: post.id, prompt: post.prompt, assetId: post.assetId, srcWidth: post.width, srcHeight: post.height }}
        renditions={listRenditions(app.db, post.id).map((r) => ({ presetId: r.presetId, platform: r.platform, label: r.label, width: r.width, height: r.height, assetId: r.assetId, bytes: r.bytes, method: r.method, createdAt: r.createdAt, upscaledFrom: r.upscaledFrom, note: r.note, ratioNote: r.ratioNote, safeZone: r.safeZone }))}
        presets={loadSizes().map((p) => ({ id: p.id, platform: p.platform, label: p.label, width: p.width, height: p.height, ratio: p.ratio, safeZone: p.safeZone, maxBytes: p.maxBytes }))}
        fallback={app.switches.outpaintFallback}
      />
    </>
  );
}
