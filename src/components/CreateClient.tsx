"use client";
import { useState } from "react";
import { postJson } from "./post.ts";
import type { GenerateView } from "../server/generate.ts";

export default function CreateClient(props: { ratios: readonly string[]; priceText: string; stateText: string; ready: boolean; warn: boolean; totalsText: string }) {
  const [prompt, setPrompt] = useState("");
  const [ratio, setRatio] = useState(props.ratios[0] ?? "4:5");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<GenerateView | null>(null);
  const [netError, setNetError] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [saved, setSaved] = useState<string | null>(null);

  async function generate() {
    setBusy(true); setResult(null); setNetError(null); setSaved(null); setNotes("");
    const r = await postJson<Partial<GenerateView> & { error?: string }>("/api/generate", { prompt, ratio });
    setBusy(false);
    if (r.data && typeof r.data.generationId === "string") setResult(r.data as GenerateView);
    else setNetError(r.data?.error ?? `The app didn't answer (HTTP ${r.status}). Nothing new is shown; check Settings → Spend before retrying.`);
  }

  async function save() {
    if (!result) return;
    const r = await postJson<{ id?: number; already?: boolean; error?: string }>("/api/library", { generationId: result.generationId, notes });
    setSaved(r.ok ? (r.data?.already ? "Already in the library." : "Saved to library.") : (r.data?.error ?? `Save failed (HTTP ${r.status}).`));
  }

  return (
    <div>
      <div className="card">
        <div className="row"><strong>Grok Imagine 2.0</strong><span className="muted">{props.priceText}</span><span className={props.ready ? "muted" : "error"}>{props.stateText}</span></div>
        <div className="muted">This month: {props.totalsText}</div>
        {props.warn ? <div className="warn">Spend is at 80% or more of the monthly cap.</div> : null}
      </div>
      <label htmlFor="prompt">Prompt</label>
      <textarea id="prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={64000} />
      <div className="row">
        <label htmlFor="ratio">Aspect ratio</label>
        <select id="ratio" value={ratio} onChange={(e) => setRatio(e.target.value)}>
          {props.ratios.map((r) => <option key={r} value={r}>{r}{r === "4:5" ? " (made at 3:4, cropped)" : ""}</option>)}
        </select>
        <span className="muted">1 image · est. {props.priceText.replace(" / image", "")}</span>
      </div>
      <button onClick={generate} disabled={busy || !prompt.trim()}>{busy ? "Making… (up to 2 min)" : "Generate"}</button>
      {netError ? <p className="error">{netError}</p> : null}
      {result ? (
        <div className="card tile" data-status={result.status}>
          {result.label ? <p className="warn">{result.label}</p> : null}
          {result.status === "ok" && result.image ? (
            <>
              <img src={`/api/assets/${result.image.assetId}`} alt={prompt} width={result.image.width ?? undefined} height={result.image.height ?? undefined} />
              {result.displayNote ? <p className="muted">{result.displayNote}</p> : null}
              <p className="muted">Grok · {result.latencyMs !== null ? `${(result.latencyMs / 1000).toFixed(1)} s` : ""} · {result.costText} · Ref {result.ref?.slice(0, 8)}</p>
              <input type="text" placeholder="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
              <div className="row"><button onClick={save} disabled={saved !== null && saved !== "" && !saved.startsWith("Save failed")}>Save to library</button>{saved ? <span>{saved}</span> : null}</div>
            </>
          ) : (
            <>
              <p className="error">{result.message}</p>
              {result.costText ? <p className="muted">Cost: {result.costText}{result.ref ? ` · Ref ${result.ref.slice(0, 8)}` : ""}</p> : null}
              {result.code === "auth" || result.code === "no_key" ? <p><a href="/settings">Open Settings</a></p> : null}
              {result.status === "error" ? <button className="secondary" onClick={generate} disabled={busy}>Retry</button> : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
