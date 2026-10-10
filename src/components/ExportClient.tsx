"use client";
// A6: the export UI. Make exact-size renditions per platform (item 24), drag the crop if the smart crop
// missed the subject, widen with "AI extend (Nano Banana 2)" when the frame would cut the subject (item 9,
// one paid edit), then download the ZIP (one image per platform + captions.txt). P3: when Google refuses
// or fails a widen, the real error shows and the fallback that exists is offered (switch outpaintFallback).
import { useRef, useState } from "react";
import { postJson } from "./post.ts";
import { frameFor } from "../lib/crop-frame.ts";

interface Preset { id: string; platform: string; label: string; width: number; height: number; ratio: string; safeZone: { x: number; y: number; w: number; h: number } | null; maxBytes: number | null }
interface Rendition { presetId: string; platform: string; label: string; width: number; height: number; assetId: string; bytes: number; method: string; createdAt: string; upscaledFrom: number | null; note: string | null; ratioNote: string | null; safeZone: { x: number; y: number; w: number; h: number } | null }

export interface ExportClientProps {
  post: { id: number; prompt: string; assetId: string; srcWidth: number; srcHeight: number };
  renditions: Rendition[];
  presets: Preset[];
  fallback: "none" | "recraft";
}

const kb = (n: number) => `${Math.round(n / 1024)} KB`;

export default function ExportClient({ post, renditions: rend0, presets, fallback }: ExportClientProps) {
  const [rend, setRend] = useState<Record<string, Rendition>>(() => Object.fromEntries(rend0.map((r) => [r.presetId, r])));
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [exportTicked, setExportTicked] = useState<Set<string>>(() => new Set(rend0.map((r) => r.presetId)));
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cropOpen, setCropOpen] = useState<string | null>(null);
  const [cropCx, setCropCx] = useState(0.5);
  const [cropCy, setCropCy] = useState(0.5);
  const [cropScale, setCropScale] = useState(1);
  const cropWrapRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);

  const setOneBusy = (id: string, what: string) => setBusy((b) => ({ ...b, [id]: what }));
  const clearOneBusy = (id: string) => setBusy((b) => { const n = { ...b }; delete n[id]; return n; });

  const makeOne = async (presetId: string, crop: { x: number; y: number; w: number; h: number } | null): Promise<boolean> => {
    setMessage(null);
    setOneBusy(presetId, crop ? "Applying crop…" : "Making…");
    try {
      const r = await postJson<{ ok?: boolean; rendition?: Rendition; error?: string }>("/api/renditions", { postId: post.id, presetId, crop });
      if (!r.ok || !r.data?.rendition) { setMessage(r.data?.error ?? "The rendition did not save."); return false; }
      setRend((m) => ({ ...m, [presetId]: r.data!.rendition! }));
      setExportTicked((s) => new Set(s).add(presetId));
      return true;
    } finally { clearOneBusy(presetId); }
  };

  const makeAll = async () => {
    setMessage(null);
    const want = presets.filter((p) => ticked.has(p.id) && !rend[p.id]).map((p) => p.id);
    if (!want.length) { setMessage("Tick at least one platform without a rendition yet."); return; }
    for (const id of want) { const ok = await makeOne(id, null); if (!ok) return; }
    setNotice(`Made ${want.length} rendition${want.length === 1 ? "" : "s"}.`);
  };

  const widen = async (presetId: string) => {
    setMessage(null); setNotice(null);
    setOneBusy(presetId, "AI extending (one paid edit)…");
    try {
      const r = await postJson<{ ok?: boolean; kind?: string; message?: string; fallback?: "none" | "recraft"; rendition?: Rendition; costText?: string; error?: string }>("/api/renditions/widen", { postId: post.id, presetId });
      if (!r.ok && r.data?.error) { setMessage(r.data.error); return; }
      if (r.data?.kind === "ok" && r.data.rendition) {
        setRend((m) => ({ ...m, [presetId]: r.data!.rendition! }));
        setExportTicked((s) => new Set(s).add(presetId));
        setNotice(`Extended with Nano Banana 2. ${r.data.costText ?? ""}`.trim());
        return;
      }
      const fb = r.data?.fallback ?? fallback;
      const tail = fb === "none"
        ? " No fallback on this computer yet. Crop instead?"
        : " The Recraft fallback is selected (adapter not built yet).";
      setMessage(`${r.data?.message ?? "The widen call failed."}${tail}${r.data?.costText ? ` (${r.data.costText})` : ""}`);
    } finally { clearOneBusy(presetId); }
  };

  const remove = async (presetId: string) => {
    setMessage(null);
    const r = await postJson<{ ok?: boolean; error?: string }>("/api/renditions/remove", { postId: post.id, presetId });
    if (r.ok) {
      setRend((m) => { const n = { ...m }; delete n[presetId]; return n; });
      setExportTicked((s) => { const n = new Set(s); n.delete(presetId); return n; });
      if (cropOpen === presetId) setCropOpen(null);
    } else setMessage(r.data?.error ?? "That rendition could not be removed.");
  };

  const exportZip = async () => {
    setMessage(null); setNotice(null);
    try {
      const res = await fetch("/api/export", { method: "POST", headers: { "Content-Type": "application/json", "x-rsr": "1" }, body: JSON.stringify({ postId: post.id, presets: [...exportTicked] }) });
      if (!res.ok) {
        let msg = "The export did not build.";
        try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* not json */ }
        setMessage(msg);
        return;
      }
      const blob = await res.blob();
      const cd = res.headers.get("content-disposition") ?? "";
      const name = /filename="([^"]+)"/.exec(cd)?.[1] ?? "export.zip";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = name; a.click();
      URL.revokeObjectURL(url);
      setNotice(`Downloaded ${name} (${kb(blob.size)}).`);
    } catch { setMessage("The export did not build."); }
  };

  const toggle = (set: Set<string>, id: string): Set<string> => { const n = new Set(set); if (n.has(id)) n.delete(id); else n.add(id); return n; };

  const openCrop = (presetId: string) => {
    setCropOpen(presetId); setCropCx(0.5); setCropCy(0.5); setCropScale(1); setMessage(null);
  };

  const onFramePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    (e.target as HTMLDivElement).setPointerCapture(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, cx: cropCx, cy: cropCy };
  };
  const onFramePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current; if (!d) return;
    const w = cropWrapRef.current?.clientWidth ?? 1;
    const h = cropWrapRef.current?.clientHeight ?? 1;
    setCropCx(Math.min(1, Math.max(0, d.cx + (e.clientX - d.x) / w)));
    setCropCy(Math.min(1, Math.max(0, d.cy + (e.clientY - d.y) / h)));
  };
  const onFramePointerUp = () => { dragRef.current = null; };

  const cropPreset = cropOpen ? presets.find((p) => p.id === cropOpen) : undefined;
  const frame = cropPreset ? frameFor(cropPreset.width, cropPreset.height, post.srcWidth, post.srcHeight, cropCx, cropCy, cropScale) : null;

  return (
    <div className="design-wrap">
      <div>
        {presets.filter((p) => rend[p.id]).map((p) => {
          const r = rend[p.id]!;
          return (
            <div className="panel" key={p.id} data-preset={p.id}>
              <h3>{p.label} <span className="mini muted">{r.width}×{r.height} · {kb(r.bytes)}</span>{" "}
                <span className={`pill${r.method === "ai_extend" ? " ai" : ""}`}>{r.method === "ai_extend" ? "AI extend (Nano Banana 2)" : "Smart crop"}</span>
                {r.upscaledFrom !== null && r.upscaledFrom < r.width ? <span className="muted mini"> · Upscaled from {r.upscaledFrom} px wide</span> : null}
              </h3>
              <div className="rel cropview">
                <img src={`/api/assets/${r.assetId}`} alt={p.label} />
                {r.safeZone ? <div className="safe" style={{ left: `${(r.safeZone.x / r.width) * 100}%`, top: `${(r.safeZone.y / r.height) * 100}%`, width: `${(r.safeZone.w / r.width) * 100}%`, height: `${(r.safeZone.h / r.height) * 100}%` }} /> : null}
              </div>
              {r.ratioNote ? <p className="muted mini">source {r.ratioNote}</p> : null}
              <div className="ctl-row">
                {cropOpen === p.id
                  ? <button type="button" onClick={() => setCropOpen(null)}>Close crop</button>
                  : <button type="button" className="secondary" disabled={!!busy[p.id]} onClick={() => openCrop(p.id)}>Adjust crop</button>}
                <button type="button" className="secondary" disabled={!!busy[p.id]} onClick={() => void widen(p.id)}>AI extend (Nano Banana 2) — one edit ≈ $0.08</button>
                <button type="button" className="danger-link mini" disabled={!!busy[p.id]} onClick={() => void remove(p.id)}>Remove</button>
              </div>
              {busy[p.id] ? <p className="muted mini">{busy[p.id]}</p> : null}
              {cropOpen === p.id && frame ? (
                <div>
                  <div className="rel cropper" ref={cropWrapRef}>
                    <img src={`/api/assets/${post.assetId}`} alt="source" draggable={false} />
                    <div
                      className="frame"
                      style={{ left: `${frame.x * 100}%`, top: `${frame.y * 100}%`, width: `${frame.w * 100}%`, height: `${frame.h * 100}%` }}
                      onPointerDown={onFramePointerDown}
                      onPointerMove={onFramePointerMove}
                      onPointerUp={onFramePointerUp}
                    />
                  </div>
                  <div className="ctl-row">
                    <label htmlFor={`zoom-${p.id}`}>Zoom</label>
                    <input id={`zoom-${p.id}`} type="range" min={1} max={4} step={0.05} value={cropScale} onChange={(e) => setCropScale(Number(e.target.value))} />
                    <button type="button" disabled={!!busy[p.id]} onClick={() => void makeOne(p.id, frame).then((ok) => { if (ok) setCropOpen(null); })}>Apply crop</button>
                    <button type="button" className="secondary" disabled={!!busy[p.id]} onClick={() => void makeOne(p.id, null).then((ok) => { if (ok) setCropOpen(null); })}>Smart crop again</button>
                  </div>
                  <p className="muted mini">Drag the frame — {p.label} keeps {p.ratio}, exactly {p.width}×{p.height} px.</p>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <div>
        <div className="panel">
          <h3>Make renditions</h3>
          <div className="chips">
            {presets.map((p) => (
              <button type="button" key={p.id} className={`chip${ticked.has(p.id) ? " on" : ""}`} onClick={() => setTicked((s) => toggle(s, p.id))}>
                {p.label} · {p.width}×{p.height}
              </button>
            ))}
          </div>
          <div className="ctl-row"><button type="button" onClick={() => void makeAll()}>Make renditions</button></div>
          <p className="muted mini">Smart crop picks the subject (attention), free and instant. Adjust it per platform after.</p>
        </div>

        <div className="panel">
          <h3>Download</h3>
          <div className="chips">
            {Object.values(rend).map((r) => (
              <button type="button" key={r.presetId} className={`chip${exportTicked.has(r.presetId) ? " on" : ""}`} onClick={() => setExportTicked((s) => toggle(s, r.presetId))}>
                {r.label}
              </button>
            ))}
          </div>
          <div className="ctl-row"><button type="button" disabled={!exportTicked.size} onClick={() => void exportZip()}>Download ZIP</button></div>
          <p className="muted mini">One image per platform plus a captions.txt built from your saved captions{fallback === "recraft" ? " · Recraft fallback selected (adapter still to build)" : ""}.</p>
          {notice ? <p className="muted mini">{notice}</p> : null}
          {message ? <p className="error">{message}</p> : null}
        </div>
      </div>
    </div>
  );
}
