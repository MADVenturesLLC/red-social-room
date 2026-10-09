// F15 body cap, enforced while streaming (Argus L6 on fa3d359): an oversized xAI body is never held in memory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { attemptOnce, readCapped, MAX_BODY_BYTES } from "../src/server/xai/http.ts";

const MB = 1024 * 1024;
function streamOf(chunks: number, chunkBytes: number, headers: Record<string, string> = {}) {
  const stats = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(c) { if (stats.pulled >= chunks) { c.close(); return; } stats.pulled++; c.enqueue(new Uint8Array(chunkBytes).fill(97)); },
    cancel() { stats.cancelled = true; },
  }, { highWaterMark: 0 });
  return { res: new Response(body, { status: 200, headers: { "content-type": "application/json", ...headers } }), stats };
}

test("F15 / Argus L6: a 60 MB body is cut off once it passes 25 MB: stream cancelled after ~26 chunks, oversize, nothing kept", async () => {
  const { res, stats } = streamOf(60, MB);
  const out = await attemptOnce(async () => res, { method: "POST", url: "http://127.0.0.1:1/x", headers: {}, body: {}, timeoutMs: 10_000 });
  assert.equal(out.oversize, true);
  assert.equal(out.text, "");
  assert.equal(out.json, null);
  assert.equal(stats.cancelled, true);
  assert.ok(stats.pulled <= MAX_BODY_BYTES / MB + 2, `pulled ${stats.pulled} chunks`);
});

test("F15 / Argus L6: a Content-Length over 25 MB is refused before reading a byte", async () => {
  const { res, stats } = streamOf(60, MB, { "content-length": String(60 * MB) });
  const out = await readCapped(res, MAX_BODY_BYTES);
  assert.equal(out.oversize, true);
  assert.equal(stats.pulled, 0);
});

test("F15: a body just under the cap is read whole", async () => {
  const { res } = streamOf(3, MB);
  const out = await readCapped(res, MAX_BODY_BYTES);
  assert.equal(out.oversize, false);
  assert.equal(out.buf.length, 3 * MB);
});

// Argus L2 on f63676e: the exact boundary. MAX_BODY_BYTES itself is allowed; one byte more is not.
function streamSizes(sizes: number[], headers: Record<string, string> = {}) {
  const stats = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(c) { if (stats.pulled >= sizes.length) { c.close(); return; } c.enqueue(new Uint8Array(sizes[stats.pulled++]).fill(97)); },
    cancel() { stats.cancelled = true; },
  }, { highWaterMark: 0 });
  return { res: new Response(body, { status: 200, headers: { "content-type": "application/json", ...headers } }), stats };
}
const exactCap = () => Array.from({ length: MAX_BODY_BYTES / MB }, () => MB);

test("F15 boundary (Argus L2): a streamed body of exactly 25 MB is read whole and not cancelled", async () => {
  assert.equal(MAX_BODY_BYTES, 25 * MB);
  const { res, stats } = streamSizes(exactCap());
  const out = await readCapped(res, MAX_BODY_BYTES);
  assert.equal(out.oversize, false);
  assert.equal(out.buf.length, MAX_BODY_BYTES);
  assert.equal(stats.cancelled, false);
});

test("F15 boundary (Argus L2): a streamed body of 25 MB + 1 byte is refused and the stream cancelled", async () => {
  const { res, stats } = streamSizes([...exactCap(), 1]);
  const out = await readCapped(res, MAX_BODY_BYTES);
  assert.equal(out.oversize, true);
  assert.equal(out.buf.length, 0);
  assert.equal(stats.cancelled, true);
});

test("F15 boundary (Argus L2): Content-Length of exactly 25 MB is read; Content-Length of 25 MB + 1 is refused with zero chunks read", async () => {
  const ok = streamSizes(exactCap(), { "content-length": String(MAX_BODY_BYTES) });
  const a = await readCapped(ok.res, MAX_BODY_BYTES);
  assert.equal(a.oversize, false);
  assert.equal(a.buf.length, MAX_BODY_BYTES);
  const big = streamSizes([...exactCap(), 1], { "content-length": String(MAX_BODY_BYTES + 1) });
  const b = await readCapped(big.res, MAX_BODY_BYTES);
  assert.equal(b.oversize, true);
  assert.equal(big.stats.pulled, 0);
  assert.equal(big.stats.cancelled, true);
});
