// Server-sent events for one run: an initial snapshot, then one event per job status change, then one
// final `{"type":"run"}` event when every job is terminal, after which the stream closes. A subscriber
// that arrives after the run already finished gets the snapshot and an immediate close (no hang).
import { getApp } from "../../../../../server/app.ts";
import { runView, subscribeRun } from "../../../../../server/runs.ts";
import { json } from "../../../../../server/route-util.ts";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const app = getApp();
  const initial = runView(app, id);
  if (!initial) return json({ error: "Unknown run." }, 404);
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (ev: unknown) => {
        if (closed) return;
        try { controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`)); } catch { /* closed */ }
      };
      const stop = () => {
        if (closed) return;
        closed = true;
        clearInterval(iv);
        un();
        try { controller.close(); } catch { /* closed */ }
      };
      // Subscribe before the snapshot so no event between the read and the subscription is lost.
      const un = subscribeRun(app, id, (ev) => {
        send(ev);
        if ((ev as { type?: string }).type === "run") stop();
      });
      const iv = setInterval(() => send({ type: "ping" }), 15_000);
      send({ type: "snapshot", run: initial });
      // A run that is already terminal will emit no further events: close right away.
      if (initial.status !== "running") stop();
      req.signal.addEventListener("abort", stop);
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
}
