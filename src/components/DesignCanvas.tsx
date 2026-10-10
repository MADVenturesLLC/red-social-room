"use client";
// A4: the deterministic editor (TECH-PLAN-v1.md :80). Crop, rotate, four sliders, text layers and
// Brand-kit logos all happen on this client canvas (Konva); no model is involved, so every edit is free
// and exact. "Save design" flattens the canvas to a PNG, uploads it through the F14 path and stores the
// recipe on the post (src/server/design.ts), so reopening lets you change one thing without redoing the rest.
//
// Coordinates in the recipe are fractions of the rendered output (see src/lib/recipe.ts), so the same
// recipe is valid at any resolution: 4:5 crop stays 4:5, a headline stays where it was placed.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Konva from "konva";
import { Group, Image as KImage, Layer, Rect, Stage, Text as KText, Transformer } from "react-konva";
import { defaultRecipe, DESIGN_FONTS, flattenScale, outputSize, rotatedSize, type Recipe } from "../lib/recipe.ts";
import { postJson } from "./post.ts";

export interface BrandItemView { id: number; assetId: string; name: string; mime: string; width: number | null; height: number | null; bytes: number }
export interface DesignCanvasProps {
  post: { id: number; prompt: string; assetId: string; recipe: Recipe | null };
  source: { assetId: string; width: number; height: number };
  brand: BrandItemView[];
  fonts: string[];
}

type Selection = { kind: "text" | "logo"; id: string } | null;
type CropBox = { x: number; y: number; w: number; h: number };

const DISPLAY_MAX_H = 640;
const uid = () => Math.random().toString(36).slice(2, 10);
const round4 = (v: number) => Math.round(v * 10000) / 10000;

export default function DesignCanvas({ post, source, brand: brand0, fonts }: DesignCanvasProps) {
  const [recipe, setRecipe] = useState<Recipe>(() => post.recipe ?? defaultRecipe());
  const [brand, setBrand] = useState<BrandItemView[]>(brand0);
  const [selection, setSelection] = useState<Selection>(null);
  const [cropMode, setCropMode] = useState(false);
  const [cropBox, setCropBox] = useState<CropBox>({ x: 0.05, y: 0.05, w: 0.9, h: 0.9 });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [saved, setSaved] = useState(false);
  const [fontsReady, setFontsReady] = useState(false);
  const [availW, setAvailW] = useState(0);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [logoImgs, setLogoImgs] = useState<Record<string, HTMLImageElement>>({});
  const [brandName, setBrandName] = useState("");
  const [brandBusy, setBrandBusy] = useState(false);
  const [brandNotice, setBrandNotice] = useState("");

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<Konva.Stage | null>(null);
  const baseRef = useRef<Konva.Image | null>(null);
  const cropRef = useRef<Konva.Rect | null>(null);
  const cropTrRef = useRef<Konva.Transformer | null>(null);
  const trRef = useRef<Konva.Transformer | null>(null);
  const logoRefs = useRef<Map<string, Konva.Image>>(new Map());

  // The bundled fonts (public/fonts; :80) must be readable by the canvas before any flatten.
  useEffect(() => {
    let alive = true;
    Promise.all(fonts.flatMap((f) => ["400", "600", "800"].map((w) => document.fonts.load(`${w} 24px ${f}`)))).then(() => { if (alive) setFontsReady(true); });
    return () => { alive = false; };
  }, [fonts]);

  // The source image (the post's original; never the flattened render).
  useEffect(() => {
    const el = new window.Image();
    el.onload = () => setImg(el);
    el.src = `/api/assets/${source.assetId}`;
  }, [source.assetId]);

  // Logo images: everything in the kit, plus any logo a saved recipe points at.
  useEffect(() => {
    let alive = true;
    const want = new Set<string>([...brand.map((b) => b.assetId), ...recipe.logos.map((l) => l.assetId)]);
    for (const id of want) {
      if (logoImgs[id]) continue;
      const el = new window.Image();
      el.onload = () => { if (alive) setLogoImgs((m) => (m[id] ? m : { ...m, [id]: el })); };
      el.src = `/api/assets/${id}`;
    }
    return () => { alive = false; };
  }, [brand, recipe.logos, logoImgs]);

  // Fit the stage to the column.
  useLayoutEffect(() => {
    const el = wrapRef.current; if (!el) return;
    const measure = () => setAvailW(el.clientWidth || 0);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rot = useMemo(() => rotatedSize(source.width, source.height, recipe.rotate), [source.width, source.height, recipe.rotate]);
  const out = useMemo(() => outputSize(source.width, source.height, recipe), [source.width, source.height, recipe]);
  const view = cropMode ? rot : out;
  const displayScale = availW > 0 ? Math.min(availW / view.w, DISPLAY_MAX_H / view.h, 1) : 0;
  const stageW = Math.max(1, Math.round(view.w * displayScale));
  const stageH = Math.max(1, Math.round(view.h * displayScale));
  const ox = cropMode ? 0 : (recipe.crop?.x ?? 0) * rot.w;   // crop origin in rotated px
  const oy = cropMode ? 0 : (recipe.crop?.y ?? 0) * rot.h;

  // Filters on the base image; zero settings mean no filter work at all.
  useEffect(() => {
    const node = baseRef.current; if (!node || !img) return;
    const a = recipe.adjust;
    const active = a.brightness || a.contrast || a.saturation || a.warmth;
    if (!active) { node.filters([]); node.getLayer()?.batchDraw(); return; }
    node.filters([Konva.Filters.Brightness, Konva.Filters.Contrast, Konva.Filters.HSL, Konva.Filters.RGB]);
    node.brightness(Math.max(-1, Math.min(1, a.brightness / 100)));
    node.contrast(Math.max(-100, Math.min(100, a.contrast)));
    node.hue(0);
    node.luminance(1);
    node.saturation(Math.max(0, Math.min(2, 1 + a.saturation / 100))); // HSL filter: 1 = untouched, 0 = greyscale
    node.red(255); node.green(255); node.blue(255);
    if (a.warmth > 0) node.blue(Math.max(0, 255 - a.warmth * 0.6));
    else if (a.warmth < 0) node.red(Math.max(0, 255 + a.warmth * 0.6));
    node.cache({ pixelRatio: Math.max(1, Math.min(2, flattenScale(out.w, out.h) / Math.max(0.2, displayScale))) });
    node.getLayer()?.batchDraw();
    return () => { try { node.clearCache(); } catch { /* node gone */ } };
  }, [recipe.adjust, img, displayScale, out.w, out.h]);

  // The crop transformer attaches while the crop editor is open (a prop would be reset on re-render).
  useEffect(() => {
    const tr = cropTrRef.current; if (!tr) return;
    if (cropMode && cropRef.current) { tr.nodes([cropRef.current]); tr.getLayer()?.batchDraw(); } else tr.nodes([]);
  }, [cropMode]);

  // The logo transformer follows the selection.
  useEffect(() => {
    const tr = trRef.current; if (!tr) return;
    const node = selection?.kind === "logo" ? logoRefs.current.get(selection.id) : undefined;
    tr.nodes(node ? [node] : []);
    tr.getLayer()?.batchDraw();
  }, [selection, recipe.logos, displayScale, logoImgs]);

  const setAdjust = (k: keyof Recipe["adjust"], v: number) => setRecipe((r) => ({ ...r, adjust: { ...r.adjust, [k]: v } }));
  const patchText = (id: string, patch: Partial<Recipe["texts"][number]>) =>
    setRecipe((r) => ({ ...r, texts: r.texts.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
  const patchLogo = (id: string, patch: Partial<Recipe["logos"][number]>) =>
    setRecipe((r) => ({ ...r, logos: r.logos.map((l) => (l.id === id ? { ...l, ...patch } : l)) }));

  const addHeadline = () => {
    const id = uid();
    setRecipe((r) => ({ ...r, texts: [...r.texts, { id, text: "Your headline", x: 0.12, y: 0.08, font: fonts[0] ?? "Inter", size: 0.09, color: "#ffffff", strokeWidth: 0, strokeColor: "#111111", shadow: true }] }));
    setSelection({ kind: "text", id });
    setCropMode(false);
  };
  const addLogoToDesign = (b: BrandItemView) => {
    const id = uid();
    setRecipe((r) => ({ ...r, logos: [...r.logos, { id, assetId: b.assetId, x: 0.4, y: 0.72, scale: 0.22 }] }));
    setSelection({ kind: "logo", id });
    setCropMode(false);
  };
  const removeSelected = () => {
    if (!selection) return;
    setRecipe((r) => selection.kind === "text"
      ? { ...r, texts: r.texts.filter((t) => t.id !== selection.id) }
      : { ...r, logos: r.logos.filter((l) => l.id !== selection.id) });
    setSelection(null);
  };

  // Crop helpers
  const enterCrop = () => {
    setCropBox(recipe.crop ?? { x: 0.05, y: 0.05, w: 0.9, h: 0.9 });
    setCropMode(true); setSelection(null);
  };
  const applyCrop = () => {
    const c = { x: round4(Math.max(0, Math.min(cropBox.x, 1))), y: round4(Math.max(0, Math.min(cropBox.y, 1))), w: round4(Math.min(cropBox.w, 1)), h: round4(Math.min(cropBox.h, 1)) };
    c.w = Math.min(c.w, 1 - c.x); c.h = Math.min(c.h, 1 - c.y);
    setRecipe((r) => ({ ...r, crop: c }));
    setCropMode(false);
  };
  const setRatio = (r: number) => {
    setCropBox((b) => {
      let w = b.w, h = (w * rot.w) / (r * rot.h);
      if (h > 0.95) { h = 0.95; w = (h * rot.h * r) / rot.w; }
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      const x = Math.max(0, Math.min(cx - w / 2, 1 - w)), y = Math.max(0, Math.min(cy - h / 2, 1 - h));
      return { x: round4(x), y: round4(y), w: round4(w), h: round4(h) };
    });
  };

  // Brand kit
  const addBrandFile = async (file: File) => {
    setBrandBusy(true); setBrandNotice("");
    try {
      const data: string = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.onerror = () => rej(new Error("read failed")); fr.readAsDataURL(file); });
      const name = (brandName.trim() || file.name.replace(/\.[a-z0-9]+$/i, "")).slice(0, 80) || "Logo";
      const r = await postJson<{ id: number; assetId: string; name: string; mime: string; width: number | null; height: number | null; bytes: number; error?: string }>("/api/brand", { data, name });
      if (r.ok && r.data?.assetId) { setBrand((b) => [r.data as BrandItemView, ...b]); setBrandName(""); }
      else setBrandNotice(r.data?.error ?? "The logo did not upload.");
    } finally { setBrandBusy(false); }
  };
  const removeBrandItem = async (id: number) => {
    setBrandNotice("");
    try {
      const res = await fetch(`/api/brand?id=${id}`, { method: "DELETE", headers: { "Content-Type": "application/json", "x-rsr": "1" } });
      if (res.ok) setBrand((b) => b.filter((x) => x.id !== id));
      else setBrandNotice("That logo could not be removed.");
    } catch { setBrandNotice("That logo could not be removed."); }
  };

  // Save: flatten, upload (F14 path), store the recipe on the post.
  const save = useCallback(async () => {
    setBusy(true); setNotice(""); setSaved(false);
    try {
      if (cropMode) throw new Error("Apply or cancel the crop first.");
      setSelection(null);
      await new Promise((r) => setTimeout(r, 80)); // let the transformer clear before flattening
      const stage = stageRef.current;
      if (!stage) throw new Error("The editor is not ready yet.");
      const fs = flattenScale(out.w, out.h);
      const url = stage.toDataURL({ pixelRatio: fs / Math.max(displayScale, 0.001), mimeType: "image/png" });
      const up = await postJson<{ assetId: string; error?: string }>("/api/upload", { data: url });
      if (!up.ok || !up.data?.assetId) throw new Error(up.data?.error ?? "The flattened image did not upload.");
      const res = await postJson<{ assetId: string; error?: string }>("/api/posts/update", { postId: post.id, assetId: up.data.assetId, recipe });
      if (!res.ok) throw new Error(res.data?.error ?? "The design did not save.");
      setSaved(true); setNotice("Saved. The library now shows this version.");
    } catch (e) {
      setNotice((e as Error).message);
    } finally { setBusy(false); }
  }, [cropMode, out.w, out.h, displayScale, post.id, recipe]);

  const selectedText = selection?.kind === "text" ? recipe.texts.find((t) => t.id === selection.id) ?? null : null;
  const selectedLogo = selection?.kind === "logo" ? recipe.logos.find((l) => l.id === selection.id) ?? null : null;
  const ready = img && displayScale > 0;
  const cropPx = { x: cropBox.x * stageW, y: cropBox.y * stageH, w: cropBox.w * stageW, h: cropBox.h * stageH };

  return (
    <div className="design-wrap">
      <div>
        <div className="stage-box" ref={wrapRef}>
          {!ready ? <p className="muted">Loading the image…</p> : (
            <Stage
              ref={stageRef}
              width={stageW}
              height={stageH}
              onMouseDown={(e) => { if (e.target === e.target.getStage()) setSelection(null); }}
              onTouchStart={(e) => { if (e.target === e.target.getStage()) setSelection(null); }}
            >
              <Layer>
                <Group x={-ox * displayScale} y={-oy * displayScale}>
                  <KImage
                    ref={baseRef}
                    image={img ?? undefined}
                    x={(rot.w / 2) * displayScale}
                    y={(rot.h / 2) * displayScale}
                    width={source.width * displayScale}
                    height={source.height * displayScale}
                    offsetX={(source.width * displayScale) / 2}
                    offsetY={(source.height * displayScale) / 2}
                    rotation={recipe.rotate}
                  />
                </Group>
                {cropMode ? (
                  <>
                    <Rect x={0} y={0} width={stageW} height={cropPx.y} fill="rgba(0,0,0,0.55)" />
                    <Rect x={0} y={cropPx.y + cropPx.h} width={stageW} height={Math.max(0, stageH - cropPx.y - cropPx.h)} fill="rgba(0,0,0,0.55)" />
                    <Rect x={0} y={cropPx.y} width={cropPx.x} height={cropPx.h} fill="rgba(0,0,0,0.55)" />
                    <Rect x={cropPx.x + cropPx.w} y={cropPx.y} width={Math.max(0, stageW - cropPx.x - cropPx.w)} height={cropPx.h} fill="rgba(0,0,0,0.55)" />
                    <Rect
                      ref={cropRef}
                      x={cropPx.x} y={cropPx.y} width={cropPx.w} height={cropPx.h}
                      stroke="#87CEEB" strokeWidth={2} dash={[6, 4]} draggable
                      onDragEnd={(e) => setCropBox((b) => ({ ...b, x: round4(Math.max(0, Math.min(e.target.x() / stageW, 1 - b.w))), y: round4(Math.max(0, Math.min(e.target.y() / stageH, 1 - b.h))) }))}
                      onTransformEnd={() => {
                        const n = cropRef.current; if (!n) return;
                        const w = Math.max(0.02, (n.width() * n.scaleX()) / stageW);
                        const h = Math.max(0.02, (n.height() * n.scaleY()) / stageH);
                        n.scaleX(1); n.scaleY(1);
                        setCropBox({ x: round4(Math.max(0, Math.min(n.x() / stageW, 1 - w))), y: round4(Math.max(0, Math.min(n.y() / stageH, 1 - h))), w: round4(w), h: round4(h) });
                      }}
                    />
                    <Transformer
                      ref={cropTrRef}
                      rotateEnabled={false}
                      keepRatio={false}
                      boundBoxFunc={(oldBox, newBox) => {
                        if (newBox.width < 32 || newBox.height < 32) return oldBox;
                        return { ...newBox, x: Math.max(0, Math.min(newBox.x, stageW - newBox.width)), y: Math.max(0, Math.min(newBox.y, stageH - newBox.height)) };
                      }}
                    />
                  </>
                ) : null}
              </Layer>
              <Layer>
                {recipe.texts.map((t) => (
                  <KText
                    key={t.id}
                    text={t.text}
                    x={t.x * stageW}
                    y={t.y * stageH}
                    fontSize={t.size * stageH}
                    fontFamily={t.font}
                    fill={t.color}
                    stroke={t.strokeWidth > 0 ? t.strokeColor : undefined}
                    strokeWidth={t.strokeWidth > 0 ? t.strokeWidth * displayScale : 0}
                    fillAfterStrokeEnabled
                    shadowColor="#000000"
                    shadowBlur={t.shadow ? t.size * stageH * 0.18 : 0}
                    shadowOpacity={t.shadow ? 0.65 : 0}
                    shadowOffsetY={t.shadow ? t.size * stageH * 0.03 : 0}
                    draggable={!cropMode}
                    onMouseDown={() => setSelection({ kind: "text", id: t.id })}
                    onTap={() => setSelection({ kind: "text", id: t.id })}
                    onDragEnd={(e) => patchText(t.id, { x: round4(Math.max(0, Math.min(e.target.x() / stageW, 1))), y: round4(Math.max(0, Math.min(e.target.y() / stageH, 1))) })}
                    opacity={cropMode ? 0.25 : 1}
                  />
                ))}
                {recipe.logos.map((l) => {
                  const li = logoImgs[l.assetId];
                  if (!li) return null;
                  const w = l.scale * stageW;
                  const h = (li.naturalHeight || 1) / (li.naturalWidth || 1) * w;
                  return (
                    <KImage
                      key={l.id}
                      ref={(node) => { if (node) logoRefs.current.set(l.id, node); else logoRefs.current.delete(l.id); }}
                      image={li}
                      x={l.x * stageW}
                      y={l.y * stageH}
                      width={w}
                      height={h}
                      draggable={!cropMode}
                      onMouseDown={() => setSelection({ kind: "logo", id: l.id })}
                      onTap={() => setSelection({ kind: "logo", id: l.id })}
                      onDragEnd={(e) => patchLogo(l.id, { x: round4(Math.max(0, Math.min(e.target.x() / stageW, 1))), y: round4(Math.max(0, Math.min(e.target.y() / stageH, 1))) })}
                      onTransformEnd={(e) => {
                        const sc = e.target.scaleX();
                        e.target.scaleX(1); e.target.scaleY(1);
                        patchLogo(l.id, { scale: Math.max(0.02, Math.min(2, round4(l.scale * sc))), x: round4(Math.max(0, Math.min(e.target.x() / stageW, 1))), y: round4(Math.max(0, Math.min(e.target.y() / stageH, 1))) });
                      }}
                      opacity={cropMode ? 0.25 : 1}
                    />
                  );
                })}
                <Transformer ref={trRef} rotateEnabled={false} keepRatio enabledAnchors={["top-left", "top-right", "bottom-left", "bottom-right"]} />
              </Layer>
            </Stage>
          )}
        </div>
        {cropMode ? (
          <div className="panel">
            <h3>Crop</h3>
            <div className="chips">
              <button className="chip" type="button" onClick={() => setRatio(1)}>1:1</button>
              <button className="chip" type="button" onClick={() => setRatio(4 / 5)}>4:5</button>
              <button className="chip" type="button" onClick={() => setRatio(16 / 9)}>16:9</button>
              <button className="chip" type="button" onClick={() => setRatio(9 / 16)}>9:16</button>
            </div>
            <div className="ctl-row" style={{ marginTop: 10 }}>
              <button type="button" onClick={applyCrop}>Apply crop</button>
              <button type="button" onClick={() => setCropMode(false)}>Cancel</button>
              <button type="button" onClick={() => { setCropBox({ x: 0, y: 0, w: 1, h: 1 }); }}>Full image</button>
            </div>
            <p className="muted mini">Drag the box or its handles. Rotate first if you want a different orientation.</p>
          </div>
        ) : (
          <div className="panel">
            <h3>Image</h3>
            <div className="ctl-row">
              <button type="button" onClick={() => { setRecipe((r) => ({ ...r, rotate: (r.rotate + 270) % 360 })); }}>⟲ Rotate left</button>
              <button type="button" onClick={() => { setRecipe((r) => ({ ...r, rotate: (r.rotate + 90) % 360 })); }}>⟳ Rotate right</button>
              <button type="button" onClick={enterCrop}>{recipe.crop ? "Crop again" : "Crop"}</button>
              {recipe.crop ? <button type="button" onClick={() => setRecipe((r) => ({ ...r, crop: null }))}>Reset crop</button> : null}
            </div>
            {(["brightness", "contrast", "saturation", "warmth"] as const).map((k) => (
              <div className="ctl-row" key={k}>
                <label htmlFor={`sl-${k}`}>{k}</label>
                <input id={`sl-${k}`} type="range" min={-100} max={100} step={1} value={recipe.adjust[k]} onChange={(e) => setAdjust(k, Number(e.target.value))} />
                <span className="slider-val">{recipe.adjust[k]}</span>
              </div>
            ))}
            {recipe.adjust.brightness || recipe.adjust.contrast || recipe.adjust.saturation || recipe.adjust.warmth ? (
              <button type="button" className="mini" onClick={() => setRecipe((r) => ({ ...r, adjust: { brightness: 0, contrast: 0, saturation: 0, warmth: 0 } }))}>Reset sliders</button>
            ) : null}
          </div>
        )}
      </div>

      <div>
        <div className="panel">
          <h3>Layers</h3>
          <div className="ctl-row">
            <button type="button" onClick={addHeadline}>＋ Add headline</button>
            {selection ? <button type="button" className="danger-link" onClick={removeSelected}>Remove selected</button> : null}
          </div>
          {recipe.texts.map((t) => (
            <div key={t.id} className={`layer-row${selection?.kind === "text" && selection.id === t.id ? " sel" : ""}`} onClick={() => setSelection({ kind: "text", id: t.id })}>
              <span className="name">T · {t.text || "(empty)"}</span>
            </div>
          ))}
          {recipe.logos.map((l) => {
            const b = brand.find((x) => x.assetId === l.assetId);
            return (
              <div key={l.id} className={`layer-row${selection?.kind === "logo" && selection.id === l.id ? " sel" : ""}`} onClick={() => setSelection({ kind: "logo", id: l.id })}>
                <span className="name">◆ {b?.name ?? "Logo"}</span>
              </div>
            );
          })}
          {!recipe.texts.length && !recipe.logos.length ? <p className="muted mini">Nothing yet — add a headline or a logo.</p> : null}
        </div>

        {selectedText ? (
          <div className="panel">
            <h3>Headline</h3>
            <div className="ctl-row"><label htmlFor="t-text">Text</label><input id="t-text" type="text" maxLength={200} value={selectedText.text} onChange={(e) => patchText(selectedText.id, { text: e.target.value })} /></div>
            <div className="ctl-row"><label htmlFor="t-font">Font</label>
              <select id="t-font" value={selectedText.font} onChange={(e) => patchText(selectedText.id, { font: e.target.value })}>
                {DESIGN_FONTS.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </div>
            <div className="ctl-row"><label htmlFor="t-size">Size</label><input id="t-size" type="range" min={0.02} max={0.3} step={0.005} value={selectedText.size} onChange={(e) => patchText(selectedText.id, { size: Number(e.target.value) })} /><span className="slider-val">{Math.round(selectedText.size * 100)}%</span></div>
            <div className="ctl-row"><label htmlFor="t-color">Colour</label><input id="t-color" type="color" value={selectedText.color} onChange={(e) => patchText(selectedText.id, { color: e.target.value })} /></div>
            <div className="ctl-row"><label htmlFor="t-shadow">Shadow</label><input id="t-shadow" type="checkbox" checked={selectedText.shadow} onChange={(e) => patchText(selectedText.id, { shadow: e.target.checked })} /></div>
            <div className="ctl-row"><label htmlFor="t-stroke">Stroke</label><input id="t-stroke" type="range" min={0} max={20} step={1} value={selectedText.strokeWidth} onChange={(e) => patchText(selectedText.id, { strokeWidth: Number(e.target.value) })} /><span className="slider-val">{selectedText.strokeWidth}px</span></div>
            {selectedText.strokeWidth > 0 ? (
              <div className="ctl-row"><label htmlFor="t-strokec">Stroke colour</label><input id="t-strokec" type="color" value={selectedText.strokeColor} onChange={(e) => patchText(selectedText.id, { strokeColor: e.target.value })} /></div>
            ) : null}
            <p className="muted mini">Drag it on the canvas to move it; the next edit starts from where you put it.</p>
          </div>
        ) : null}

        {selectedLogo ? (
          <div className="panel">
            <h3>Logo</h3>
            <div className="ctl-row"><label htmlFor="l-scale">Size</label><input id="l-scale" type="range" min={0.02} max={2} step={0.01} value={selectedLogo.scale} onChange={(e) => patchLogo(selectedLogo.id, { scale: Number(e.target.value) })} /><span className="slider-val">{Math.round(selectedLogo.scale * 100)}%</span></div>
            <p className="muted mini">Drag to move; the corner handles scale it (shape is kept).</p>
          </div>
        ) : null}

        <div className="panel">
          <h3>Brand kit</h3>
          {brandNotice ? <p className="muted mini">{brandNotice}</p> : null}
          <div className="ctl-row">
            <input type="text" placeholder="Logo name" value={brandName} maxLength={80} onChange={(e) => setBrandName(e.target.value)} />
          </div>
          <div className="ctl-row">
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              disabled={brandBusy}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void addBrandFile(f); e.target.value = ""; }}
            />
          </div>
          <p className="muted mini">PNG, JPEG, WebP or SVG. SVG logos are drawn on your canvas only — never sent to a model — and are served sandboxed.</p>
          {brand.map((b) => (
            <div className="brand-item" key={b.id}>
              <img src={`/api/assets/${b.assetId}`} alt={b.name} />
              <span className="name" style={{ flex: 1 }}>{b.name}</span>
              <button type="button" className="chip" onClick={() => addLogoToDesign(b)}>Add</button>
              <button type="button" className="danger-link mini" onClick={() => void removeBrandItem(b.id)}>✕</button>
            </div>
          ))}
          {!brand.length ? <p className="muted mini">No logos yet — upload one.</p> : null}
        </div>

        <div className="panel">
          <button type="button" onClick={() => void save()} disabled={busy || !ready}>
            {busy ? "Saving…" : "Save design"}
          </button>{" "}
          <button type="button" className="mini" onClick={() => { setRecipe(defaultRecipe()); setSelection(null); setCropMode(false); }}>Start over</button>
          {!fontsReady ? <p className="muted mini">Fonts are still loading; saving will wait a moment.</p> : null}
          {notice ? <p className="muted">{notice} {saved ? <a href="/library">Open the library</a> : null}</p> : null}
          <p className="muted mini">Free — canvas only. The flattened PNG replaces this post's library image; the original stays in the store and the recipe is saved so you can reopen and change one thing.</p>
        </div>
      </div>
    </div>
  );
}
