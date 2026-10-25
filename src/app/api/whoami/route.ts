// B1: who is using the app right now, from the Cloudflare Access header on the request.
// The header is set by Access at the door and blocked from outside spoofing; a request without it comes
// from the box or the tailnet and counts as the owner. The server's spend gate reads the same header.
import { json } from "../../../server/route-util.ts";
import { actorFromRequest } from "../../../server/actor.ts";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const actor = actorFromRequest(req);
  return json({
    name: actor.name,
    role: actor.role,
    email: actor.email,
    canSpend: actor.canSpend,
    via: actor.via,
  });
}
