// App configuration: data paths and the Founder-decision switches (config/switches.json).
// Every switch value is validated at startup. A value that A1 does not implement stops the app
// (fail closed) instead of silently running the default.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const REPO_ROOT = resolve(/*turbopackIgnore: true*/ process.env.RSR_APP_ROOT ?? process.cwd());

export function dataDir(): string {
  return resolve(/*turbopackIgnore: true*/ process.env.RSR_DATA_DIR ?? join(REPO_ROOT, "data"));
}

/** P1 (Amendment 1 section 2.2): A1 builds the name-list method only (section 4 line 278). */
export type PromptCheckConfig = { method: "name_list"; onFailure: "block" | "send_labeled"; override: "none" };
/** P7: which xAI 4xx rejections settle at $0. A1 default = the spike's narrow rule (spike/lib/xai-shape.ts:21-28). */
export type XaiRejectionCost = "spike_narrow_422" | "item16_assumed_zero";
/** P4: xAI data retention. zdr = Michael turned on ZDR in the console; the app only logs the header. */
export type XaiDataRetention = "default_30_days" | "zdr";
/** P6: xAI quality. Option A = the measured defaults (generate low, edit medium), sent without a quality field. */
export type XaiQuality = "measured_defaults";
/** P5: output resolution. A1 builds option A only (every request asks for 1K). */
export type FinalResolution = "1k_upscale";

export interface Switches {
  promptCheck: PromptCheckConfig;
  xaiRejectionCost: XaiRejectionCost;
  xaiDataRetention: XaiDataRetention;
  xaiQuality: XaiQuality;
  finalResolution: FinalResolution;
}

export class ConfigError extends Error {
  constructor(message: string) { super(message); this.name = "ConfigError"; }
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], what: string): T {
  if (typeof v === "string" && (allowed as readonly string[]).includes(v)) return v as T;
  throw new ConfigError(`config/switches.json: ${what} = ${JSON.stringify(v)} is not built in A1 (allowed: ${allowed.join(", ")}). The app will not start until it is fixed.`);
}

export function parseSwitches(raw: unknown): Switches {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const pc = (o.promptCheck && typeof o.promptCheck === "object" ? o.promptCheck : {}) as Record<string, unknown>;
  return Object.freeze({
    promptCheck: Object.freeze({
      method: oneOf(pc.method, ["name_list"] as const, "promptCheck.method"),
      onFailure: oneOf(pc.onFailure, ["block", "send_labeled"] as const, "promptCheck.onFailure"),
      override: oneOf(pc.override, ["none"] as const, "promptCheck.override"),
    }),
    xaiRejectionCost: oneOf(o.xaiRejectionCost, ["spike_narrow_422", "item16_assumed_zero"] as const, "xaiRejectionCost"),
    xaiDataRetention: oneOf(o.xaiDataRetention, ["default_30_days", "zdr"] as const, "xaiDataRetention"),
    xaiQuality: oneOf(o.xaiQuality, ["measured_defaults"] as const, "xaiQuality"),
    finalResolution: oneOf(o.finalResolution, ["1k_upscale"] as const, "finalResolution"),
  });
}

export function loadSwitches(path = join(REPO_ROOT, "config", "switches.json")): Switches {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(/*turbopackIgnore: true*/ path, "utf8")); } catch (e) {
    throw new ConfigError(`Cannot read ${path}: ${(e as Error).message}. The app will not start without its switches.`);
  }
  return parseSwitches(raw);
}

/** Resolution sent to xAI for a generation, from the P5 switch. */
export function resolutionFor(s: Switches): "1k" {
  switch (s.finalResolution) { case "1k_upscale": return "1k"; }
}

/** Quality used for pricing, and whether the field is sent (P6). The xAI OpenAPI GenerateImageRequest
 *  (https://api.x.ai/api-docs/openapi.json, read 2026-10-07) lists no `quality` property, and the spike's
 *  measured $0.04 generate was sent without one, so option A omits the field. */
export function qualityFor(s: Switches, kind: "generate" | "edit"): { priceQuality: "low" | "medium"; send: boolean } {
  switch (s.xaiQuality) { case "measured_defaults": return { priceQuality: kind === "generate" ? "low" : "medium", send: false }; }
}
