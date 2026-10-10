"use client";
// A2 Create: creator cards (tick, choose 1-4 images each), one prompt to every chosen card, then a live
// grid of tiles fed by server-sent events (GET /api/run/<id>/events) with a polling fallback.
// A3: "Bring your own image" (upload, F14's browser check here + the server's own check in /api/upload)
// and per-tile Edit / Use as reference, which open EditPanel (version strip + lineage).
import { useEffect, useRef, useState } from "react";
import { postJson } from "./post.ts";
import EditPanel, { type EditSource } from "./EditPanel.tsx";
import { precheckUpload, resizeDimensions } from "../lib/upload-rules.ts";
import type { JobView, RunView } from "../server/runs.ts";
import type { CreatorStatus } from "../server/status.ts";
import type { ReuseData, Snippet } from "../server/library.ts";

const usd = (micros: number) => `$${(micros / 1e6).toFixed(2)}`;

function fileToBase64(f: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { const s = String(r.result ?? ""); resolve(s.slice(s.indexOf(",") + 1)); };
    r.onerror = () => reject(new Error("read failed"));
    r.readAsDataURL(f);
  });
}

/** The "Resize to 4096 px and continue?" path (F14): draw the image at the reduced size, re-encode as PNG. */
async function shrinkTo(f: Blob, w: number, h: number): Promise<Blob> {
  const bmp = await createImageBitmap(f);
  const dim = resizeDimensions(w, h);
  const c = document.createElement("canvas");
  c.width = dim.width; c.height = dim.height;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("no canvas");
  ctx.drawImage(bmp, 0, 0, dim.width, dim.height);
  return await new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("resize failed"))), "image/png"));
}

export default function CreateClient(props: { ratios: readonly string[]; creators: CreatorStatus[]; warn: boolean; totalsText: string; prefill: ReuseData | null; recent: readonly string[]; snippets: readonly Snippet[] }) {
  const prefill = props.prefill;
  const [prompt, setPrompt] = useState(prefill?.prompt ?? "");
  const [ratio, setRatio] = useState(() => (prefill && props.ratios.includes(prefill.ratio) ? prefill.ratio : (props.ratios[0] ?? "4:5")));
  const [selected, setSelected] = useState<Record<string, boolean>>(() =>
    // A7 reuse-run: only the model that made the original starts ticked (when it still exists).
    prefill
      ? Object.fromEntries(props.creators.map((c) => [c.id, c.id === prefill.creator]))
      // FD:11: Nano Banana 2 is the default Google creator; the Pro card starts unticked.
      : Object.fromEntries(props.creators.map((c) => [c.id, c.id !== "google-pro" && (c.state === "ready" || c.state === "key_unchecked")])));
  const [counts, setCounts] = useState<Record<string, number>>(() => Object.fromEntries(props.creators.map((c) => [c.id, 1])));
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<RunView | null>(null);
  const [netError, setNetError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [uploads, setUploads] = useState<EditSource[]>([]);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);
  const [editSource, setEditSource] = useState<EditSource | null>(null);
  const [editMode, setEditMode] = useState<"edit" | "reference">("edit");
  // A7 (T:76): the saved snippets, newest first; the recent prompts come from the server on load.
  const [snippetList, setSnippetList] = useState<Snippet[]>([...props.snippets]);
  const [snipMsg, setSnipMsg] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const chosen = props.creators.filter((c) => selected[c.id]);
  const images = chosen.reduce((n, c) => n + (counts[c.id] ?? 1), 0);
  const estimateMicros = chosen.reduce((n, c) => n + c.estimateMicros * (counts[c.id] ?? 1), 0);
  const running = run !== null && run.status === "running";
  const refCapable = props.creators.some((c) => c.maxReferenceImages > 0);

  function stopWatch() {
    esRef.current?.close(); esRef.current = null;
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }

  async function refresh(id: string): Promise<RunView | null> {
    const r = await fetch(`/api/run/${id}`, { cache: "no-store" });
    if (!r.ok) return null;
    return (await r.json()) as RunView;
  }

  function watch(id: string) {
    stopWatch();
    const tick = async () => {
      const v = await refresh(id);
      if (v) { setRun(v); if (v.status !== "running") stopWatch(); }
    };
    const es = new EventSource(`/api/run/${id}/events`);
    esRef.current = es;
    let t: ReturnType<typeof setTimeout> | null = null;
    es.onmessage = () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => { void tick(); }, 150);
    };
    es.onerror = () => {
      // Stream failed: close it and fall back to polling until the run is terminal.
      es.close(); esRef.current = null;
      if (!pollRef.current) pollRef.current = setInterval(() => { void tick(); }, 1500);
    };
  }

  useEffect(() => stopWatch, []);

  async function start(withCreators: Array<{ id: string; n: number }> = chosen.map((c) => ({ id: c.id, n: counts[c.id] ?? 1 }))) {
    setBusy(true); setRun(null); setNetError(null); setSaved({});
    const r = await postJson<{ runId?: string; blocked?: boolean; run?: RunView; error?: string }>("/api/run", { prompt, ratio, creators: withCreators });
    setBusy(false);
    if (r.data?.run && r.data.runId) {
      setRun(r.data.run);
      if (!r.data.blocked && r.data.run.status === "running") watch(r.data.runId);
    } else {
      setNetError(r.data?.error ?? `The app didn't answer (HTTP ${r.status}). Nothing new is shown; check Settings → Spend before retrying.`);
    }
  }

  async function save(job: JobView) {
    const r = await postJson<{ already?: boolean; error?: string }>("/api/library", { generationId: job.generationId, notes: notes[job.jobId] ?? "" });
    setSaved((s) => ({ ...s, [job.jobId]: r.ok ? (r.data?.already ? "Already in the library." : "Saved to library.") : (r.data?.error ?? `Save failed (HTTP ${r.status}).`) }));
  }

  /** A7 (T:76): save the current prompt as a snippet, or remove one. */
  async function saveSnippet() {
    const r = await postJson<{ snippet?: Snippet; error?: string }>("/api/snippets", { text: prompt });
    if (r.ok && r.data?.snippet) {
      const snip = r.data.snippet;
      setSnippetList((l) => (l.some((x) => x.id === snip.id) ? l : [snip, ...l]));
      setSnipMsg("Snippet saved.");
    } else setSnipMsg(r.data?.error ?? `Not saved (HTTP ${r.status}).`);
  }
  async function removeSnippet(id: number) {
    const res = await fetch(`/api/snippets?id=${id}`, { method: "DELETE", headers: { "Content-Type": "application/json", "x-rsr": "1" } });
    if (res.ok) setSnippetList((l) => l.filter((x) => x.id !== id));
    else setSnipMsg(`Not removed (HTTP ${res.status}).`);
  }

  /** F14 in the browser: type/size/dimension check, the downscale offer, then the upload. The server re-checks all of it. */
  async function onFile(f: File) {
    setUploadMsg(null);
    let blob: Blob = f;
    let w: number | null = null, h: number | null = null;
    try { const bmp = await createImageBitmap(f); w = bmp.width; h = bmp.height; bmp.close(); } catch { /* the server will re-check */ }
    const pc = precheckUpload({ type: f.type, size: f.size, width: w, height: h });
    if (pc.kind === "reject") { setUploadMsg(pc.message); return; }
    if (pc.kind === "offer_resize") {
      if (w && h) {
        if (!window.confirm(pc.message)) return;
        try { blob = await shrinkTo(f, w, h); } catch { setUploadMsg("Resizing failed in the browser. Try a smaller file."); return; }
      } else {
        setUploadMsg(`${pc.message} (The browser could not read this file's size; uploading it as-is — the server will reject it if it is too large.)`);
      }
    }
    let data: string;
    try { data = await fileToBase64(blob); } catch { setUploadMsg("Could not read that file."); return; }
    const r = await postJson<{ assetId?: string; width?: number | null; height?: number | null; error?: string }>("/api/upload", { data });
    if (r.ok && r.data?.assetId) {
      setUploads((u) => [{ assetId: r.data!.assetId!, width: r.data!.width ?? null, height: r.data!.height ?? null, fromCreator: null }, ...u]);
      setUploadMsg("Uploaded. Pick Edit or Use as reference — nothing is sent to a model until you do.");
    } else {
      setUploadMsg(r.data?.error ?? `Upload failed (HTTP ${r.status}).`);
    }
  }

  return (
    <div>
      <div className="card">
        {props.creators.map((c) => (
          <div className="row" key={c.id} data-creator={c.id} data-state={c.state}>
            <label>
              <input type="checkbox" checked={!!selected[c.id]} disabled={running || c.state === "no_key" || c.state === "cap_reached"}
                onChange={(e) => setSelected((s) => ({ ...s, [c.id]: e.target.checked }))} /> <strong>{c.name}</strong>
            </label>
            <span className="muted">{c.priceText}</span>
            <label className="muted">images{" "}
              <select value={counts[c.id] ?? 1} disabled={running} onChange={(e) => setCounts((s) => ({ ...s, [c.id]: Number(e.target.value) }))}>
                {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <span className={c.state === "ready" || c.state === "key_unchecked" ? "muted" : c.state === "provider_problems" ? "warn" : "error"}>{c.stateText}</span>
          </div>
        ))}
        <div className="muted">This month: {props.totalsText}</div>
        {props.warn ? <div className="warn">Spend is at 80% or more of the monthly cap.</div> : null}
      </div>

      <div className="card" data-upload>
        <strong>Bring your own image</strong>
        <p className="muted">PNG, JPEG or WebP — up to 20 MB and 8,000 px a side. Uploading is free; a model is only called when you choose an action.</p>
        <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); e.currentTarget.value = ""; }} />
        {uploadMsg ? <p className="muted">{uploadMsg}</p> : null}
        {uploads.map((u) => (
          <div className="row" key={u.assetId} data-uploaded={u.assetId.slice(0, 8)}>
            <img src={`/api/assets/${u.assetId}`} alt="" width={72} height={72} style={{ objectFit: "cover", borderRadius: 6 }} />
            <button className="secondary" onClick={() => { setEditSource(u); setEditMode("edit"); }}>Edit</button>
            <button className="secondary" disabled={!refCapable} onClick={() => { setEditSource(u); setEditMode("reference"); }}>Use as reference</button>
          </div>
        ))}
      </div>

      {prefill ? <p className="muted" data-reuse>Reusing post #{prefill.postId} — prompt and model are filled in.</p> : null}
      {props.recent.length > 0 ? (
        <div className="row" data-recent>
          <span className="muted">Recent:</span>
          {props.recent.map((q) => <button type="button" key={q} className="secondary" onClick={() => setPrompt(q)}>{q.length > 40 ? `${q.slice(0, 40)}…` : q}</button>)}
        </div>
      ) : null}
      {snippetList.length > 0 ? (
        <div className="row" data-snippets>
          <span className="muted">Snippets:</span>
          {snippetList.map((sn) => (
            <span key={sn.id} className="row" data-snippet={sn.id}>
              <button type="button" className="secondary" onClick={() => setPrompt(sn.text)}>{sn.text.length > 40 ? `${sn.text.slice(0, 40)}…` : sn.text}</button>
              <button type="button" className="secondary" onClick={() => void removeSnippet(sn.id)} aria-label={`Remove snippet ${sn.id}`}>×</button>
            </span>
          ))}
        </div>
      ) : null}
      <label htmlFor="prompt">Prompt</label>
      <textarea id="prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={64000} />
      <div className="row">
        <button type="button" className="secondary" onClick={() => void saveSnippet()} disabled={!prompt.trim()}>Save as snippet</button>
        {snipMsg ? <span className="muted">{snipMsg}</span> : null}
      </div>
      <div className="row">
        <label htmlFor="ratio">Aspect ratio</label>
        <select id="ratio" value={ratio} onChange={(e) => setRatio(e.target.value)}>
          {props.ratios.map((r) => <option key={r} value={r}>{r}{r === "4:5" ? " (Grok makes it at 3:4, cropped)" : ""}</option>)}
        </select>
        <span className="muted">{images} image{images === 1 ? "" : "s"} · est. {usd(estimateMicros)}</span>
      </div>
      <button onClick={() => void start()} disabled={busy || running || !prompt.trim() || chosen.length === 0}>{busy || running ? "Making… (up to 2 min)" : "Generate"}</button>
      {netError ? <p className="error">{netError}</p> : null}
      {run ? (
        <div>
          {run.jobs.some((j) => j.view?.label) ? <p className="warn">{run.jobs.find((j) => j.view?.label)?.view?.label}</p> : null}
          <div className="grid" data-run={run.id} data-status={run.status}>
            {run.jobs.map((job) => {
              const v = job.view;
              const sv = saved[job.jobId];
              return (
                <div className="card tile" key={job.jobId} data-status={job.status} data-creator={job.creator}>
                  <p className="muted"><strong>{job.name}</strong> · {job.status === "queued" || job.status === "running" ? "making…" : job.status}</p>
                  {job.status === "ok" && v?.image ? (
                    <>
                      <img src={`/api/assets/${v.image.assetId}`} alt={prompt} width={v.image.width ?? undefined} height={v.image.height ?? undefined} />
                      {v.displayNote ? <p className="muted">{v.displayNote}</p> : null}
                      <p className="muted">{job.name} · {v.latencyMs !== null ? `${(v.latencyMs / 1000).toFixed(1)} s` : ""} · {v.costText} · Ref {v.ref?.slice(0, 8)}</p>
                      <input type="text" placeholder="Notes (optional)" value={notes[job.jobId] ?? ""} onChange={(e) => setNotes((s) => ({ ...s, [job.jobId]: e.target.value }))} maxLength={2000} />
                      <div className="row">
                        <button onClick={() => void save(job)} disabled={sv !== undefined && !sv.startsWith("Save failed")}>Save to library</button>
                        <button className="secondary" onClick={() => { setEditSource({ assetId: v.image!.assetId, width: v.image!.width, height: v.image!.height, fromCreator: job.creator }); setEditMode("edit"); }}>Edit</button>
                        <button className="secondary" disabled={!refCapable} onClick={() => { setEditSource({ assetId: v.image!.assetId, width: v.image!.width, height: v.image!.height, fromCreator: job.creator }); setEditMode("reference"); }}>Use as reference</button>
                        {sv ? <span>{sv}</span> : null}
                      </div>
                    </>
                  ) : job.status === "queued" || job.status === "running" ? (
                    <p className="muted">Making… (up to 2 min)</p>
                  ) : (
                    <>
                      <p className={job.status === "refused" ? "warn" : "error"}>{v?.message ?? "Not sent."}</p>
                      {v?.costText ? <p className="muted">Cost: {v.costText}{v.ref ? ` · Ref ${v.ref.slice(0, 8)}` : ""}</p> : null}
                      {v?.code === "auth" || v?.code === "no_key" || v?.code === "cap" ? <p><a href="/settings">Open Settings</a></p> : null}
                      {job.status === "error" || job.status === "refused" ? (
                        <button className="secondary" onClick={() => void start([{ id: job.creator, n: 1 }])} disabled={busy || running}>{job.status === "refused" ? "Try again" : "Retry"}</button>
                      ) : null}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {editSource ? (
        <EditPanel key={`${editSource.assetId}-${editMode}`} creators={props.creators} ratios={props.ratios} source={editSource} initialMode={editMode} onClose={() => setEditSource(null)} />
      ) : null}
    </div>
  );
}
