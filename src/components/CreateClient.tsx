"use client";
// A2 Create: creator cards (tick, choose 1-4 images each), one prompt to every chosen card, then a live
// grid of tiles fed by server-sent events (GET /api/run/<id>/events) with a polling fallback.
import { useEffect, useRef, useState } from "react";
import { postJson } from "./post.ts";
import type { JobView, RunView } from "../server/runs.ts";
import type { CreatorStatus } from "../server/status.ts";

export default function CreateClient(props: { ratios: readonly string[]; creators: CreatorStatus[]; warn: boolean; totalsText: string }) {
  const [prompt, setPrompt] = useState("");
  const [ratio, setRatio] = useState(props.ratios[0] ?? "4:5");
  const [selected, setSelected] = useState<Record<string, boolean>>(() =>
    // FD:11: Nano Banana 2 is the default Google creator; the Pro card starts unticked.
    Object.fromEntries(props.creators.map((c) => [c.id, c.id !== "google-pro" && (c.state === "ready" || c.state === "key_unchecked")])));
  const [counts, setCounts] = useState<Record<string, number>>(() => Object.fromEntries(props.creators.map((c) => [c.id, 1])));
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<RunView | null>(null);
  const [netError, setNetError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Record<string, string>>({});
  const esRef = useRef<EventSource | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const chosen = props.creators.filter((c) => selected[c.id]);
  const images = chosen.reduce((n, c) => n + (counts[c.id] ?? 1), 0);
  const estimateMicros = chosen.reduce((n, c) => n + c.estimateMicros * (counts[c.id] ?? 1), 0);
  const running = run !== null && run.status === "running";

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
      <label htmlFor="prompt">Prompt</label>
      <textarea id="prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={64000} />
      <div className="row">
        <label htmlFor="ratio">Aspect ratio</label>
        <select id="ratio" value={ratio} onChange={(e) => setRatio(e.target.value)}>
          {props.ratios.map((r) => <option key={r} value={r}>{r}{r === "4:5" ? " (Grok makes it at 3:4, cropped)" : ""}</option>)}
        </select>
        <span className="muted">{images} image{images === 1 ? "" : "s"} · est. ${(estimateMicros / 1e6).toFixed(2)}</span>
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
    </div>
  );
}
