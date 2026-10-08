// Real-person pre-send check (Founder decision 7, Amendment 1 item 4 / D1 / F10 / G7).
// Interface: checkPrompt(text) -> { allowed, reason, cost }. A1 ships the name-list method and, by default,
// blocks when the check cannot run (section 4 line 278; P1a/P1c pending). The list is re-read on every
// check, so editing config/real-person-names.txt takes effect without a restart.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isoNY } from "../../spike/lib/ledger.ts";
import type { PromptCheckConfig } from "./config.ts";
import type { DB } from "./db.ts";

export const BLOCKED_TEXT = "Not sent: this prompt asks for a photoreal image of a real person. Your rule blocks these.";
export const UNAVAILABLE_TEXT = "Prompt check unavailable. Retry.";
export const SENT_UNCHECKED_LABEL = "Sent without the real-person check (check unavailable)";

/** What a detection method reports. `unavailable` = the method could not run (never treated as "allowed"). */
export interface MethodResult { result: "allowed" | "blocked" | "unavailable"; reason: string | null; costMicros: number }
export interface PromptCheckMethod { readonly name: string; run(text: string): MethodResult }

/** checkPrompt's answer after the P1c switch is applied. */
export interface CheckPromptResult { allowed: boolean; result: MethodResult["result"]; reason: string | null; cost: number; message: string | null; label: string | null; method: string }

function norm(s: string): string {
  return ` ${s.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
}

export function nameListMethod(path: string): PromptCheckMethod {
  return {
    name: "name_list",
    run(text: string): MethodResult {
      let names: string[];
      try {
        names = readFileSync(path, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
      } catch (e) {
        return { result: "unavailable", reason: `name list unreadable (${(e as NodeJS.ErrnoException).code ?? "error"})`, costMicros: 0 };
      }
      if (names.length === 0) return { result: "unavailable", reason: "name list is empty", costMicros: 0 };
      const p = norm(text);
      for (const n of names) {
        const nn = norm(n);
        if (nn.trim() && p.includes(nn)) return { result: "blocked", reason: `names a listed real person: ${n}`, costMicros: 0 };
      }
      return { result: "allowed", reason: null, costMicros: 0 };
    },
  };
}

export function checkPrompt(text: string, method: PromptCheckMethod, cfg: PromptCheckConfig, db?: DB): CheckPromptResult {
  let r: MethodResult;
  try { r = method.run(text); } catch (e) { r = { result: "unavailable", reason: `check threw: ${(e as Error).name}`, costMicros: 0 }; }
  if (db) {
    db.prepare("INSERT INTO prompt_checks (created_at, prompt_sha256, result, reason, method) VALUES (?, ?, ?, ?, ?)")
      .run(isoNY(), createHash("sha256").update(text).digest("hex"), r.result, r.reason, method.name);
  }
  const base = { result: r.result, reason: r.reason, cost: r.costMicros, method: method.name };
  if (r.result === "allowed") return { ...base, allowed: true, message: null, label: null };
  if (r.result === "blocked") return { ...base, allowed: false, message: BLOCKED_TEXT, label: null };
  if (cfg.onFailure === "send_labeled") return { ...base, allowed: true, message: null, label: SENT_UNCHECKED_LABEL };
  return { ...base, allowed: false, message: UNAVAILABLE_TEXT, label: null };
}
