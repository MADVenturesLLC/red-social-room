// A4: the deterministic editor page (TECH-PLAN-v1.md :80, :96-97). The editor renders from the post's
// ORIGINAL source image plus its saved recipe, so reopening never re-does the rest.
import { notFound } from "next/navigation";
import { getApp } from "../../../server/app.ts";
import { getPostDesign } from "../../../server/design.ts";
import { listBrand } from "../../../server/brand.ts";
import { DESIGN_FONTS } from "../../../lib/recipe.ts";
import DesignShell from "../../../components/DesignShell.tsx";

export const dynamic = "force-dynamic";

export default async function DesignPage({ params }: { params: Promise<{ postId: string }> }) {
  const { postId } = await params;
  const app = getApp();
  const post = getPostDesign(app.db, postId);
  if (!post) notFound();
  const src = app.db.prepare("SELECT width, height FROM assets WHERE id = ?").get(post.sourceAssetId) as { width: number | null; height: number | null } | undefined;
  if (!src || !src.width || !src.height) notFound();
  return (
    <>
      <h1>Design <span className="muted mini">{post.prompt}</span></h1>
      <p className="muted">Everything here is canvas work — no model, no cost. “Save design” flattens this canvas and stores the recipe beside it, so you can reopen and change one thing without redoing the rest.</p>
      <DesignShell
        post={{ id: post.id, prompt: post.prompt, assetId: post.assetId, recipe: post.recipe }}
        source={{ assetId: post.sourceAssetId, width: src.width, height: src.height }}
        brand={listBrand(app.db).map((b) => ({ id: b.id, assetId: b.assetId, name: b.name, mime: b.mime, width: b.width, height: b.height, bytes: b.bytes }))}
        fonts={[...DESIGN_FONTS]}
      />
    </>
  );
}
