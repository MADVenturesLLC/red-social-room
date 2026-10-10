"use client";
// A5: the captions UI (T:99, section 6). "Write captions" sends the final image, the prompt, the ticked
// platforms, the tone, the notes and the brand voice to /api/captions (server-side: real-person check,
// cap check, token-estimated cost). Options come back per platform with live character counters against
// the platform's limit; over-limit text is flagged red, never cut. Saving writes the chosen option;
// suggested tags are added only when ticked.
import { useState } from "react";
import { postJson } from "./post.ts";
import type { PlatformDef, ToneDef, SavedCaption, PostTag } from "../server/captions.ts";

export interface CaptionsClientProps {
  post: { id: number; prompt: string; assetId: string };
  captions: SavedCaption[];
  tags: PostTag[];
  brandVoice: string;
  platforms: PlatformDef[];
  tones: ToneDef[];
}

interface ResultState { options: string[]; hashtags: string; altText: string; limit: number; picked: number; saved: boolean }

const DEFAULT_TICKED = 4;

export default function CaptionsClient({ post, captions: captions0, tags: tags0, brandVoice: bv0, platforms, tones }: CaptionsClientProps) {
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(platforms.slice(0, DEFAULT_TICKED).map((p) => p.id)));
  const [tone, setTone] = useState(tones[0]?.id ?? "");
  const [notes, setNotes] = useState("");
  const [brandVoice, setBrandVoice] = useState(bv0);
  const [bvNotice, setBvNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [genBusy, setGenBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [costText, setCostText] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, ResultState>>(() => {
    const out: Record<string, ResultState> = {};
    for (const c of captions0) {
      const p = platforms.find((x) => x.id === c.platform);
      if (!p) continue;
      out[c.platform] = { options: [c.text], hashtags: c.hashtags, altText: c.altText, limit: p.captionLimit, picked: 0, saved: true };
    }
    return out;
  });
  const [suggestedTags, setSuggestedTags] = useState<string[]>([]);
  const [checkedTags, setCheckedTags] = useState<Set<string>>(new Set());
  const [tags, setTags] = useState<PostTag[]>(tags0);
  const [tagNotice, setTagNotice] = useState("");

  const saveBrandVoice = async () => {
    setBvNotice("");
    const r = await postJson<{ ok?: boolean; text?: string; error?: string }>("/api/settings/brandvoice", { text: brandVoice });
    setBvNotice(r.ok ? "Saved — it rides with every caption call." : r.data?.error ?? "The brand voice did not save.");
  };

  const generate = async () => {
    setMessage(null); setCostText(null); setGenBusy(true);
    try {
      const r = await postJson<{ kind?: string; message?: string; code?: string; platforms?: Record<string, { captions: string[]; hashtags: string[]; altText: string; limit: number; overLimit: boolean }>; tags?: string[]; cost?: { micros: number | null; source: string } | null; error?: string }>("/api/captions", { postId: post.id, platforms: [...ticked], tone, notes });
      if (!r.ok || !r.data) { setMessage(r.data?.error ?? "The caption call did not go through."); return; }
      const d = r.data;
      if (d.kind !== "ok") {
        const money = d.cost && d.cost.micros !== null ? ` Cost: $${(d.cost.micros / 1e6).toFixed(4)} (est. from usage).` : "";
        setMessage((d.message ?? "The caption call failed.") + money);
        return;
      }
      const next: Record<string, ResultState> = {};
      for (const [pid, v] of Object.entries(d.platforms ?? {})) {
        next[pid] = { options: v.captions, hashtags: v.hashtags.join(" "), altText: v.altText, limit: v.limit, picked: 0, saved: false };
      }
      setResults(next);
      setSuggestedTags(d.tags ?? []);
      setCheckedTags(new Set());
      setTagNotice("");
      setCostText(d.cost && d.cost.micros !== null ? `That call cost about $${(d.cost.micros / 1e6).toFixed(4)} (est. from usage tokens).` : null);
    } finally { setGenBusy(false); }
  };

  const saveOne = async (pid: string) => {
    const r = results[pid];
    if (!r) return;
    setBusy(true); setMessage(null);
    try {
      const res = await postJson<{ ok?: boolean; error?: string }>("/api/captions/save", { postId: post.id, platform: pid, text: r.options[r.picked] ?? r.options[0] ?? "", hashtags: r.hashtags, altText: r.altText });
      if (!res.ok) { setMessage(res.data?.error ?? "The caption did not save."); return; }
      setResults((m) => ({ ...m, [pid]: { ...m[pid], saved: true } }));
    } finally { setBusy(false); }
  };

  const addTags = async () => {
    setTagNotice("");
    const list = [...checkedTags];
    if (!list.length) { setTagNotice("Tick the tags you want first."); return; }
    const r = await postJson<{ ok?: boolean; tags?: PostTag[]; error?: string }>("/api/tags", { postId: post.id, tags: list });
    if (r.ok && r.data?.tags) { setTags(r.data.tags); setTagNotice("Added."); }
    else setTagNotice(r.data?.error ?? "The tags did not save.");
  };

  const toggleTicked = (id: string) => setTicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <div className="design-wrap">
      <div>
        <div className="stage-box">
          <img src={`/api/assets/${post.assetId}`} alt={post.prompt} style={{ maxWidth: "100%", maxHeight: 420, display: "block" }} />
        </div>

        {Object.entries(results).map(([pid, r]) => {
          const def = platforms.find((p) => p.id === pid);
          const over = r.options.map((o) => o.length > r.limit);
          return (
            <div className="panel" key={pid} data-platform={pid}>
              <h3>{def?.label ?? pid} <span className="mini muted">limit {r.limit.toLocaleString()} chars{def && !def.verified ? " (unverified)" : ""}</span> {r.saved ? <span className="mini" style={{ color: "#2a7" }}>saved ✓</span> : null}</h3>
              {r.options.map((o, i) => (
                <div key={i} className="ctl-row" style={{ alignItems: "flex-start" }}>
                  <input type="radio" name={`pick-${pid}`} checked={r.picked === i} onChange={() => setResults((m) => ({ ...m, [pid]: { ...m[pid], picked: i } }))} aria-label={`Option ${i + 1}`} />
                  <textarea
                    value={o}
                    rows={Math.min(6, Math.max(2, Math.ceil(o.length / 70)))}
                    style={{ width: "100%" }}
                    onChange={(e) => setResults((m) => { const opt = [...m[pid].options]; opt[i] = e.target.value; return { ...m, [pid]: { ...m[pid], options: opt, saved: false } }; })}
                  />
                  <span className={o.length > r.limit ? "counter over" : "counter"}>{o.length.toLocaleString()}/{r.limit.toLocaleString()}</span>
                </div>
              ))}
              {over.some(Boolean) ? <p className="error mini">Over the {def?.label ?? pid} limit{r.options.filter((_, i) => over[i]).length > 1 ? " in one option" : ""} — flagged, not cut. Shorten it or pick the other option.</p> : null}
              <div className="ctl-row"><label htmlFor={`tags-${pid}`}>Hashtags</label><input id={`tags-${pid}`} type="text" value={r.hashtags} onChange={(e) => setResults((m) => ({ ...m, [pid]: { ...m[pid], hashtags: e.target.value, saved: false } }))} /></div>
              <div className="ctl-row"><label htmlFor={`alt-${pid}`}>Alt text</label><input id={`alt-${pid}`} type="text" value={r.altText} onChange={(e) => setResults((m) => ({ ...m, [pid]: { ...m[pid], altText: e.target.value, saved: false } }))} /></div>
              <button type="button" disabled={busy} onClick={() => void saveOne(pid)}>Save this caption</button>
            </div>
          );
        })}
      </div>

      <div>
        <div className="panel">
          <h3>Write captions</h3>
          <div className="chips">
            {platforms.map((p) => (
              <button type="button" key={p.id} className={`chip${ticked.has(p.id) ? " on" : ""}`} onClick={() => toggleTicked(p.id)}>{p.label}</button>
            ))}
          </div>
          <div className="ctl-row"><label htmlFor="tone">Tone</label>
            <select id="tone" value={tone} onChange={(e) => setTone(e.target.value)}>
              {tones.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </div>
          <div className="ctl-row"><label htmlFor="notes">Notes</label><input id="notes" type="text" maxLength={500} placeholder="anything to mention" value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
          <button type="button" onClick={() => void generate()} disabled={genBusy || !ticked.size}>{genBusy ? "Writing…" : "Write captions"}</button>
          <p className="muted mini">One call for all ticked platforms — well under a cent; the real cost is shown after and settles from the API’s token usage.</p>
          {message ? <p className="error">{message}</p> : null}
          {costText ? <p className="muted mini">{costText}</p> : null}
        </div>

        <div className="panel">
          <h3>Brand voice</h3>
          <textarea value={brandVoice} rows={4} maxLength={2000} onChange={(e) => setBrandVoice(e.target.value)} placeholder="How MAD Ventures sounds, in your words. Written once." />
          <div className="ctl-row"><button type="button" className="secondary" onClick={() => void saveBrandVoice()}>Save brand voice</button></div>
          {bvNotice ? <p className="muted mini">{bvNotice}</p> : null}
        </div>

        <div className="panel">
          <h3>Suggested tags</h3>
          {suggestedTags.length ? (
            <>
              <div className="chips">
                {suggestedTags.map((t) => (
                  <button type="button" key={t} className={`chip${checkedTags.has(t) ? " on" : ""}`} onClick={() => setCheckedTags((s) => { const n = new Set(s); if (n.has(t)) n.delete(t); else n.add(t); return n; })}>{t}</button>
                ))}
              </div>
              <div className="ctl-row"><button type="button" className="secondary" onClick={() => void addTags()}>Add ticked tags</button></div>
              <p className="muted mini">Nothing is added silently — only the tags you tick.</p>
            </>
          ) : <p className="muted mini">Write captions first; tags come back with them.</p>}
          {tagNotice ? <p className="muted mini">{tagNotice}</p> : null}
          {tags.length ? <p className="muted mini">On this post: {tags.map((t) => t.name).join(", ")}</p> : null}
        </div>
      </div>
    </div>
  );
}
