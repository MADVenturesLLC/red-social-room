"use client";
// A3: edit / "use as reference" panel + the version strip. One source image in, a new child out; every
// version is its own file and the strip follows generations.parent_asset_id (GET /api/lineage). Compare
// edit sends the same instruction string to two models (item 28). Costs are shown before running; a
// failed edit appears in the strip with its error and no image (F13).
import { useEffect, useRef, useState } from "react";
import { postJson } from "./post.ts";
import type { RunView } from "../server/runs.ts";
import type { CreatorStatus } from "../server/status.ts";
import type { LineageNode } from "../server/lineage.ts";

export interface EditSource { assetId: string; width: number | null; height: number | null; fromCreator: string | null }

const usd = (micros: number) => `$${(micros / 1e6).toFixed(2)}`;

export default function EditPanel(props: { creators: CreatorStatus[]; ratios: readonly string[]; source: EditSource; initialMode: "edit" | "reference"; canSpend?: boolean; onClose: () => void }) {
  const [mode, setMode] = useState<"edit" | "reference">(props.initialMode);
  const [instruction, setInstruction] = useState("");
  const [model, setModel] = useState(() => {
    if (props.source.fromCreator && props.creators.some((c) => c.id === props.source.fromCreator)) return props.source.fromCreator;
    return props.creators.find((c) => c.id === "google")?.id ?? props.creators[0]?.id ?? "";
  });
  const [compare, setCompare] = useState(false);
  const [model2, setModel2] = useState(() => {
    const first = props.creators.find((c) => c.id !== model);
    return first?.id ?? "";
  });
  const [ratio, setRatio] = useState(props.ratios[0] ?? "4:5");
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<RunView | null>(null);
  const [chain, setChain] = useState<{ rootAssetId: string; nodes: LineageNode[] } | null>(null);
  const [base, setBase] = useState(props.source.assetId);
  const [selected, setSelected] = useState(props.source.assetId);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refCapable = props.creators.filter((c) => c.maxReferenceImages > 0);
  const running = run !== null && run.status === "running";
  const modelsOut = mode === "edit" ? (compare ? [model, model2] : [model]) : [model];
  const costMicros = mode === "edit"
    ? modelsOut.reduce((n, id) => n + (props.creators.find((c) => c.id === id)?.editEstimateMicros ?? 0), 0)
    : (props.creators.find((c) => c.id === model)?.estimateMicros ?? 0);

  function stopWatch() {
    esRef.current?.close(); esRef.current = null;
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }

  async function refreshChain(anchor: string): Promise<{ rootAssetId: string; nodes: LineageNode[] } | null> {
    const r = await fetch(`/api/lineage?id=${anchor}`, { cache: "no-store" });
    if (!r.ok) return null;
    const c = (await r.json()) as { rootAssetId: string; nodes: LineageNode[] };
    setChain(c);
    return c;
  }

  function afterRun(c: { nodes: LineageNode[] } | null) {
    if (!c) return;
    const newest = [...c.nodes].reverse().find((n) => n.assetId && n.status === "ok" && n.kind !== "source" && n.kind !== "generate");
    if (newest?.assetId) { setBase(newest.assetId); setSelected(newest.assetId); }
  }

  function watch(id: string) {
    stopWatch();
    const tick = async () => {
      const r = await fetch(`/api/run/${id}`, { cache: "no-store" });
      if (!r.ok) return;
      const v = (await r.json()) as RunView;
      setRun(v);
      if (v.status !== "running") { stopWatch(); void refreshChain(base).then(afterRun); }
    };
    const es = new EventSource(`/api/run/${id}/events`);
    esRef.current = es;
    let t: ReturnType<typeof setTimeout> | null = null;
    es.onmessage = () => { if (t) clearTimeout(t); t = setTimeout(() => { void tick(); }, 150); };
    es.onerror = () => {
      es.close(); esRef.current = null;
      if (!pollRef.current) pollRef.current = setInterval(() => { void tick(); }, 1500);
    };
  }

  useEffect(() => { void refreshChain(props.source.assetId); return stopWatch; }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function start() {
    setBusy(true); setErr(null); setSaved(null); setRun(null);
    const body: Record<string, unknown> = { mode, sourceAssetId: base, instruction, models: modelsOut };
    if (mode === "reference") body.ratio = ratio;
    const r = await postJson<{ runId?: string; blocked?: boolean; run?: RunView; error?: string }>("/api/edit", body);
    setBusy(false);
    if (r.data?.run && r.data.runId) {
      setRun(r.data.run);
      if (!r.data.blocked && r.data.run.status === "running") watch(r.data.runId);
      else void refreshChain(base).then(afterRun);
    } else {
      setErr(r.data?.error ?? `The app didn't answer (HTTP ${r.status}). Nothing was sent.`);
    }
  }

  async function saveVersion(node: LineageNode) {
    if (!node.generationId) return;
    const r = await postJson<{ already?: boolean; error?: string }>("/api/library", { generationId: node.generationId });
    setSaved(r.ok ? (r.data?.already ? "Already in the library." : "Saved to library.") : (r.data?.error ?? `Save failed (HTTP ${r.status}).`));
  }

  const selectedNode = chain?.nodes.find((n) => n.assetId === selected) ?? null;

  return (
    <div className="card" data-edit-panel={mode}>
      <div className="row">
        <strong>{mode === "edit" ? "Edit this image" : "Use as reference"}</strong>
        <span className="muted">source {props.source.assetId.slice(0, 8)}</span>
        <button className="secondary" onClick={props.onClose}>Close</button>
      </div>
      <div className="row">
        <button className={mode === "edit" ? "" : "secondary"} onClick={() => setMode("edit")}>Edit</button>
        <button className={mode === "reference" ? "" : "secondary"} disabled={refCapable.length === 0} onClick={() => setMode("reference")}>Use as reference</button>
        {refCapable.length === 0 ? <span className="muted">No model takes reference images right now.</span> : null}
      </div>
      <label htmlFor="edit-instruction">{mode === "edit" ? "What should change?" : "What should it become?"}</label>
      <textarea id="edit-instruction" value={instruction} onChange={(e) => setInstruction(e.target.value)} maxLength={64000} />
      <div className="row">
        {mode === "edit" ? (
          <>
            <label>Model{" "}
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                {props.creators.map((c) => <option key={c.id} value={c.id}>{c.name}{c.editPriceText ? ` (${c.editPriceText})` : ""}</option>)}
              </select>
            </label>
            <label>
              <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} /> compare edit
            </label>
            {compare ? (
              <label>second model{" "}
                <select value={model2} onChange={(e) => setModel2(e.target.value)}>
                  {props.creators.filter((c) => c.id !== model).map((c) => <option key={c.id} value={c.id}>{c.name}{c.editPriceText ? ` (${c.editPriceText})` : ""}</option>)}
                </select>
              </label>
            ) : null}
          </>
        ) : (
          <>
            <label>Model{" "}
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                {refCapable.map((c) => <option key={c.id} value={c.id}>{c.name} ({usd(c.estimateMicros)} / image)</option>)}
              </select>
            </label>
            <label>Aspect ratio{" "}
              <select value={ratio} onChange={(e) => setRatio(e.target.value)}>
                {props.ratios.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </label>
          </>
        )}
        <span className="muted">est. {usd(costMicros)}{mode === "edit" && compare ? " (compare runs both)" : ""} · same instruction goes to every model exactly as typed</span>
      </div>
      {props.canSpend === false ? <p className="warn">View-only account — edits and reference runs are off.</p> : null}
      <button onClick={() => void start()} disabled={busy || running || props.canSpend === false || !instruction.trim()}>{busy || running ? "Working… (up to 2 min)" : mode === "edit" ? "Edit" : "Make the image"}</button>
      {err ? <p className="error">{err}</p> : null}
      {run ? (
        <div className="grid" data-run={run.id} data-mode={run.mode} data-status={run.status}>
          {run.jobs.map((job) => (
            <div className="card tile" key={job.jobId} data-status={job.status} data-creator={job.creator}>
              <p className="muted"><strong>{job.name}</strong> · {job.status === "queued" || job.status === "running" ? "working…" : job.status}</p>
              {job.status === "ok" && job.view?.image ? <img src={`/api/assets/${job.view.image.assetId}`} alt="" /> : null}
              {job.status !== "ok" && job.status !== "queued" && job.status !== "running" ? <p className={job.status === "refused" ? "warn" : "error"}>{job.view?.message ?? "Not sent."}</p> : null}
              {job.view?.costText ? <p className="muted">Cost: {job.view.costText}</p> : null}
            </div>
          ))}
        </div>
      ) : null}
      {chain && chain.nodes.length > 1 ? (
        <div>
          <h3>Versions</h3>
          <div className="strip">
            {chain.nodes.map((n, i) => {
              const failed = n.status === "error" || n.status === "refused";
              return (
                <button key={`${n.generationId ?? "root"}-${i}`} className={failed ? "v failed" : "v"} data-selected={n.assetId !== null && n.assetId === selected}
                  onClick={() => { if (n.assetId) { setSelected(n.assetId); setBase(n.assetId); setSaved(null); } }}>
                  <span className="muted">v{i + 1} · {n.kind}{n.model ? ` · ${n.model}` : ""}</span>
                  {n.assetId ? <img src={`/api/assets/${n.assetId}`} alt="" /> : <span className="error">{failed ? `Edit failed: ${n.error ?? "no image"}` : "no image"}</span>}
                  <span className="muted">{n.costText}{n.status !== "ok" && n.status !== "source" ? ` · ${n.status}` : ""}</span>
                </button>
              );
            })}
          </div>
          <p className="muted">The next edit starts from the selected version; every version is kept — nothing overwrites the original.</p>
          {selectedNode && selectedNode.generationId && selectedNode.status === "ok" ? (
            <div className="row">
              <button className="secondary" onClick={() => void saveVersion(selectedNode)}>Save this version to library</button>
              {saved ? <span>{saved}</span> : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
