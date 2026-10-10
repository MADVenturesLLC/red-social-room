// A3: the version chain that contains an asset (the version strip / lineage view).
import { getApp } from "../../../server/app.ts";
import { lineageFor } from "../../../server/lineage.ts";
import { json } from "../../../server/route-util.ts";

export const dynamic = "force-dynamic";

const SHA_RE = /^[a-f0-9]{64}$/;

export async function GET(req: Request): Promise<Response> {
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!SHA_RE.test(id)) return json({ error: "Pass an asset id." }, 400);
  const chain = lineageFor(getApp().db, id);
  if (!chain) return json({ error: "Unknown asset." }, 404);
  return json(chain);
}
