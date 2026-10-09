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

export function CheckButton() {
  const [msg, setMsg] = useState<string | null>(null);
  async function run() {
    const r = await postJson<KeyResp>("/api/settings/check", {});
    setMsg(r.data?.check ? (r.data.check.ok ? "Key check passed." : r.data.check.message) : (r.data?.error ?? `HTTP ${r.status}`));
  }
  return <div className="row"><button className="secondary" onClick={run}>Check again</button>{msg ? <span>{msg}</span> : null}</div>;
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
      <label htmlFor="cap">Monthly cap (USD, shared across xAI and Google)</label>
      <input id="cap" type="number" min="0" step="0.01" value={v} onChange={(e) => setV(e.target.value)} style={{ maxWidth: "8rem" }} />
      <button type="submit">Set cap</button>
      {msg ? <span>{msg}</span> : null}
    </form>
  );
}
