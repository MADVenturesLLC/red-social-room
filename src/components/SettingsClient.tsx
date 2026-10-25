"use client";
import { useState, type FormEvent } from "react";
import { postJson } from "./post.ts";

interface KeyResp { key?: { set: boolean; source: string | null; last4: string | null }; check?: { ok: boolean; message: string | null }; error?: string }

export function KeyForm() {
  const [value, setValue] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const r = await postJson<KeyResp>("/api/settings/key", { key: value });
    setValue(""); // the typed key is dropped from the page right away
    setBusy(false);
    if (r.ok && r.data?.key) setMsg(`Saved. Key ending ${r.data.key.last4 ?? "????"}. ${r.data.check?.ok ? "Key check passed." : `Key check: ${r.data.check?.message ?? "not run"}`}`);
    else setMsg(r.data?.error ?? `Not saved (HTTP ${r.status}).`);
  }
  return (
    <form onSubmit={save}>
      <label htmlFor="xai-key">Paste a new xAI key</label>
      <div className="row">
        <input id="xai-key" type="password" autoComplete="off" spellCheck={false} value={value} onChange={(e) => setValue(e.target.value)} />
        <button type="submit" disabled={busy || !value.trim()}>Save key</button>
      </div>
      {msg ? <p className="muted">{msg} <a href="/settings">Refresh</a></p> : null}
    </form>
  );
}

/** A2: the Google key goes to its own store (secrets/gemini_api_key) through the same write-only route. */
export function GoogleKeyForm() {
  const [value, setValue] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const r = await postJson<KeyResp>("/api/settings/key", { key: value, provider: "google" });
    setValue("");
    setBusy(false);
    if (r.ok && r.data?.key) setMsg(`Saved. Key ending ${r.data.key.last4 ?? "????"}. ${r.data.check?.ok ? "Key check passed." : `Key check: ${r.data.check?.message ?? "not run"}`}`);
    else setMsg(r.data?.error ?? `Not saved (HTTP ${r.status}).`);
  }
  return (
    <form onSubmit={save}>
      <label htmlFor="google-key">Paste a new Google key</label>
      <div className="row">
        <input id="google-key" type="password" autoComplete="off" spellCheck={false} value={value} onChange={(e) => setValue(e.target.value)} />
        <button type="submit" disabled={busy || !value.trim()}>Save key</button>
      </div>
      {msg ? <p className="muted">{msg} <a href="/settings">Refresh</a></p> : null}
    </form>
  );
}

/** OpenAI (ChatGPT / GPT Image) key goes to secrets/openai_api_key through the same write-only route. */
export function OpenAiKeyForm() {
  const [value, setValue] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const r = await postJson<KeyResp>("/api/settings/key", { key: value, provider: "openai" });
    setValue("");
    setBusy(false);
    if (r.ok && r.data?.key) setMsg(`Saved. Key ending ${r.data.key.last4 ?? "????"}. ${r.data.check?.ok ? "Key check passed." : `Key check: ${r.data.check?.message ?? "not run"}`}`);
    else setMsg(r.data?.error ?? `Not saved (HTTP ${r.status}).`);
  }
  return (
    <form onSubmit={save}>
      <label htmlFor="openai-key">Paste a new OpenAI key (sk-...)</label>
      <div className="row">
        <input id="openai-key" type="password" autoComplete="off" spellCheck={false} value={value} onChange={(e) => setValue(e.target.value)} />
        <button type="submit" disabled={busy || !value.trim()}>Save key</button>
      </div>
      {msg ? <p className="muted">{msg} <a href="/settings">Refresh</a></p> : null}
    </form>
  );
}

export function CheckButton() {
  const [msg, setMsg] = useState<string | null>(null);
  async function run() {
    const r = await postJson<KeyResp & { googleCheck?: { ok: boolean; message: string | null } | null; openaiCheck?: { ok: boolean; message: string | null } | null }>("/api/settings/check", {});
    const x = r.data?.check ? (r.data.check.ok ? "xAI key check passed." : `xAI: ${r.data.check.message}`) : (r.data?.error ?? `HTTP ${r.status}`);
    const g = r.data?.googleCheck ? (r.data.googleCheck.ok ? " Google key check passed." : ` Google: ${r.data.googleCheck.message}`) : "";
    const o = r.data?.openaiCheck ? (r.data.openaiCheck.ok ? " OpenAI key check passed." : ` OpenAI: ${r.data.openaiCheck.message}`) : "";
    setMsg(x + g + o);
  }
  return <div className="row"><button className="secondary" onClick={run}>Check keys again</button>{msg ? <span>{msg}</span> : null}</div>;
}

export function CapForm(props: { capUsd: number }) {
  const [v, setV] = useState(String(props.capUsd));
  const [msg, setMsg] = useState<string | null>(null);
  async function save(e: FormEvent) {
    e.preventDefault();
    const r = await postJson<{ capText?: string; error?: string }>("/api/settings/cap", { usd: Number(v) });
    setMsg(r.ok ? `Cap set to ${r.data?.capText}.` : (r.data?.error ?? `HTTP ${r.status}`));
  }
  return (
    <form onSubmit={save} className="row">
      <label htmlFor="cap">Monthly cap (USD, shared across all providers)</label>
      <input id="cap" type="number" min="0" step="0.01" value={v} onChange={(e) => setV(e.target.value)} style={{ maxWidth: "8rem" }} />
      <button type="submit">Set cap</button>
      {msg ? <span>{msg}</span> : null}
    </form>
  );
}

/** A2 (F21): settle one unresolved row by hand: $0 ("not charged") or the amount from the provider console. */
export function ReconcileRow(props: { id: string }) {
  const [usd, setUsd] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function run(action: "not_charged" | "charged") {
    setBusy(true);
    const r = await postJson<{ ok?: boolean; error?: string }>("/api/settings/spend/reconcile", { id: props.id, action, usd: action === "charged" ? Number(usd) : undefined });
    setBusy(false);
    setMsg(r.ok ? "Done. Reload to see the new total." : (r.data?.error ?? `HTTP ${r.status}`));
  }
  return (
    <div className="row">
      <button className="secondary" disabled={busy} onClick={() => run("not_charged")}>Not charged</button>
      <input type="number" min="0" step="0.01" value={usd} onChange={(e) => setUsd(e.target.value)} style={{ maxWidth: "6rem" }} placeholder="$" aria-label="charged amount" />
      <button className="secondary" disabled={busy || usd === ""} onClick={() => run("charged")}>Charged</button>
      {msg ? <span className="muted">{msg}</span> : null}
    </div>
  );
}

/** A2 (item 8): enter the Google console total; a higher total adds one adjustment row for the difference. */
export function ConsoleForm(props: { monthNY: string }) {
  const [usd, setUsd] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  async function save(e: FormEvent) {
    e.preventDefault();
    const r = await postJson<{ ok?: boolean; adjustmentMicros?: number; error?: string }>("/api/settings/spend/google", { usd: Number(usd) });
    setMsg(r.ok
      ? (r.data?.adjustmentMicros ? `Saved. Added a $${((r.data.adjustmentMicros ?? 0) / 1e6).toFixed(2)} adjustment so the cap counts it.` : "Saved. No adjustment needed.")
      : (r.data?.error ?? `HTTP ${r.status}`));
  }
  return (
    <form onSubmit={save} className="row">
      <label htmlFor="google-total">Console total (USD) for {props.monthNY}</label>
      <input id="google-total" type="number" min="0" step="0.01" value={usd} onChange={(e) => setUsd(e.target.value)} style={{ maxWidth: "8rem" }} />
      <button type="submit" disabled={usd === ""}>Save total</button>
      {msg ? <span className="muted">{msg}</span> : null}
    </form>
  );
}

/** A7 (FD:6): the R2 backup target. Endpoint and bucket are shown back; the two keys stay server-side. */
export function R2Form(props: { configured: boolean; endpoint: string | null; bucket: string | null; keyLast4: string | null }) {
  const [endpoint, setEndpoint] = useState(props.endpoint ?? "");
  const [bucket, setBucket] = useState(props.bucket ?? "");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secret, setSecret] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const r = await postJson<{ r2?: { configured: boolean; keyLast4: string | null }; error?: string }>("/api/settings/r2", { endpoint, bucket, accessKeyId, secretAccessKey: secret });
    setAccessKeyId(""); setSecret("");
    setBusy(false);
    setMsg(r.ok && r.data?.r2 ? `Saved. Backup target is set${r.data.r2.keyLast4 ? ` (key ending ${r.data.r2.keyLast4})` : ""}.` : (r.data?.error ?? `Not saved (HTTP ${r.status}).`));
  }
  return (
    <form onSubmit={save}>
      <div className="row">
        <label htmlFor="r2-endpoint">Endpoint</label>
        <input id="r2-endpoint" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://<account id>.r2.cloudflarestorage.com" spellCheck={false} />
      </div>
      <div className="row">
        <label htmlFor="r2-bucket">Bucket</label>
        <input id="r2-bucket" value={bucket} onChange={(e) => setBucket(e.target.value)} placeholder="rsr-backup" spellCheck={false} />
      </div>
      <div className="row">
        <label htmlFor="r2-keyid">Access key id{props.keyLast4 ? ` (saved, ends ${props.keyLast4} — leave blank to keep it)` : ""}</label>
        <input id="r2-keyid" type="password" autoComplete="off" spellCheck={false} value={accessKeyId} onChange={(e) => setAccessKeyId(e.target.value)} />
      </div>
      <div className="row">
        <label htmlFor="r2-secret">Secret access key{props.configured ? " (leave blank to keep it)" : ""}</label>
        <input id="r2-secret" type="password" autoComplete="off" spellCheck={false} value={secret} onChange={(e) => setSecret(e.target.value)} />
      </div>
      <div className="row">
        <button type="submit" disabled={busy || !endpoint.trim() || !bucket.trim()}>Save backup target</button>
        {msg ? <span className="muted">{msg}</span> : null}
      </div>
    </form>
  );
}

/** A7: run the nightly backup job right now. */
export function BackupNowButton() {
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    const r = await postJson<{ ok?: boolean; filesUploaded?: number; bytesUploaded?: number; error?: string }>("/api/backup/run", {});
    setBusy(false);
    setMsg(r.data?.ok
      ? `Backed up: ${r.data.filesUploaded} new file(s), ${(((r.data.bytesUploaded ?? 0) + (0)) / 1e6).toFixed(1)} MB of files. Reload to see the times.`
      : (r.data?.error ?? `Backup failed (HTTP ${r.status}).`));
  }
  return <div className="row"><button onClick={() => void run()} disabled={busy}>{busy ? "Backing up…" : "Back up now"}</button>{msg ? <span className="muted">{msg}</span> : null}</div>;
}

/** A7 (F17): the manual search-index actions. */
export function FtsTools() {
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function run(action: "check" | "rebuild") {
    setBusy(true);
    const r = await postJson<{ report?: { posts: number; indexed: number; integrityOk: boolean; rebuilt: boolean; detail: string }; error?: string }>("/api/maintenance/fts", { action });
    setBusy(false);
    if (r.ok && r.data?.report) {
      const rep = r.data.report;
      setMsg(`posts ${rep.posts}, indexed ${rep.indexed}, integrity ${rep.integrityOk ? "ok" : "FAILED"}${rep.rebuilt ? "; the index was rebuilt" : ""}.`);
    } else setMsg(r.data?.error ?? `HTTP ${r.status}`);
  }
  return (
    <div className="row">
      <button className="secondary" disabled={busy} onClick={() => void run("check")}>Check search index</button>
      <button className="secondary" disabled={busy} onClick={() => void run("rebuild")}>Rebuild search index</button>
      {msg ? <span className="muted">{msg}</span> : null}
    </div>
  );
}
