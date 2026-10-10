// A4: read one post's design (recipe + render + source). Small JSON API used by the editor page and tests.
import { getApp } from "../../../../server/app.ts";
import { getPostDesign } from "../../../../server/design.ts";
import { json } from "../../../../server/route-util.ts";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const post = getPostDesign(getApp().db, id);
  if (!post) return json({ error: "Unknown post." }, 404);
  return json(post);
}
