// The A2 mock provider server (Amendment 1 item 22): a local HTTP server that speaks the xAI endpoints
// and the Google Interactions endpoints, with fault injection, so every §3.2 row can be exercised over
// real sockets — headers, bodies, aborts and timeouts travel the network stack, not a fetch stub — with
// zero real provider calls. Point an adapter's baseUrl (or RSR_XAI_BASE_URL / RSR_GOOGLE_BASE_URL, both
// loopback-only) at `url`. Dummy keys only.
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { sampleJpeg } from "../helpers.ts";

export type XaiScenario = "ok" | "ok-no-image" | "422-text" | "429" | "429-retry-after" | "503" | "hang";
export type GoogleScenario = "ok" | "text-only" | "400-key-invalid" | "429" | "429-retry-after" | "503" | "hang";
export interface MockRequest { provider: "xai" | "google"; method: string; path: string; body: string }

export interface MockProvider {
  url: string;
  port: number;
  xai: XaiScenario;
  google: GoogleScenario;
  retryAfterSeconds: number;
  requests: MockRequest[];
  close: () => Promise<void>;
}

export async function startMockProvider(): Promise<MockProvider> {
  const jpeg = await sampleJpeg();
  const state = { xai: "ok" as XaiScenario, google: "ok" as GoogleScenario, retryAfterSeconds: 5 };
  const requests: MockRequest[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const path = req.url ?? "";
      requests.push({ provider: path.startsWith("/v1beta/") ? "google" : "xai", method: req.method ?? "GET", path, body });
      const json = (status: number, obj: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(obj));
      };
      const text = (status: number, t: string, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "text/plain", ...headers });
        res.end(t);
      };

      if (path === "/v1/api-key") return json(200, { api_key_blocked: false, api_key_disabled: false, team_blocked: false });
      if (path === "/v1/image-generation-models") return json(200, { models: [{ id: "grok-imagine-image-2.0", version: "1.0", fingerprint: "fp_mock" }] });
      if (path === "/v1beta/models/gemini-3.1-flash-image" && req.method === "GET") {
        return json(200, { name: "models/gemini-3.1-flash-image", version: "3.0", displayName: "Nano Banana 2" });
      }
      if (path === "/v1/images/generations" && req.method === "POST") {
        if (state.xai === "hang") return; // never answers; the adapter's 120 s timeout (or the test seam) fires
        if (state.xai === "429") return text(429, "rate limited");
        if (state.xai === "429-retry-after") return text(429, "rate limited", { "retry-after": String(state.retryAfterSeconds) });
        if (state.xai === "503") return text(503, "oops");
        if (state.xai === "422-text") return text(422, "Failed to deserialize the JSON body into the target type: aspect_ratio: unknown variant `4:5`");
        if (state.xai === "ok-no-image") return json(200, { data: [], usage: { cost_in_usd_ticks: 400000000 } });
        return json(200, { data: [{ b64_json: jpeg.toString("base64"), mime_type: "image/jpeg" }], usage: { cost_in_usd_ticks: 400000000 } }, { "x-request-id": "req-mock" });
      }
      if (path === "/v1beta/interactions" && req.method === "POST") {
        if (state.google === "hang") return;
        if (state.google === "400-key-invalid") {
          return json(400, { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] } });
        }
        if (state.google === "429") return json(429, { error: { code: "rate_limit_exceeded", message: "Too many requests." } });
        if (state.google === "429-retry-after") return json(429, { error: { code: "rate_limit_exceeded" } }, { "retry-after": String(state.retryAfterSeconds) });
        if (state.google === "503") return text(503, "oops");
        if (state.google === "text-only") {
          return json(200, { id: "int-mock-refusal", status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: "I can't draw that." }] }], usage: { total_input_tokens: 12, total_output_tokens: 7, total_thought_tokens: 0 } });
        }
        return json(200, {
          id: "int-mock-ok", status: "completed", model: "gemini-3.1-flash-image",
          steps: [
            { type: "thought", signature: "sig-mock" },
            { type: "model_output", content: [{ type: "text", text: "Here it is." }, { type: "image", mime_type: "image/jpeg", data: jpeg.toString("base64") }] },
          ],
          usage: { total_input_tokens: 26, total_output_tokens: 1549, total_thought_tokens: 0, output_tokens_by_modality: [{ modality: "image", tokens: 1120 }, { modality: "text", tokens: 429 }] },
        }, { "x-request-id": "goog-mock-1" });
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    get xai() { return state.xai; },
    set xai(v: XaiScenario) { state.xai = v; },
    get google() { return state.google; },
    set google(v: GoogleScenario) { state.google = v; },
    get retryAfterSeconds() { return state.retryAfterSeconds; },
    set retryAfterSeconds(v: number) { state.retryAfterSeconds = v; },
    requests,
    close: () => new Promise<void>((r) => {
      for (const s of sockets) s.destroy();
      server.close(() => r());
    }),
  };
}
