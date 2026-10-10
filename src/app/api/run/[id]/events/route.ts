// Server-sent events for one run: an initial snapshot, then one event per job status change, then one
// final `{"type":"run"}` event when every job is terminal (the UI closes the stream on it).
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
      send({ type: "snapshot", run: initial });
      const un = subscribeRun(app, id, (ev) => {
        send(ev);
        if ((ev as { type?: string }).type === "run") stop();
      });
      const iv = setInterval(() => send({ type: "ping" }), 15_000);
      req.signal.addEventListener("abort", stop);
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
}
