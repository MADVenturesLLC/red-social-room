"use client";
// A7 housekeeping: delete one post from the Library (with a confirm). The files stay; captions, tags
// and renditions for the post go with it.
import { useState } from "react";

export default function DeletePostButton(props: { id: number }) {
  const [busy, setBusy] = useState(false);
  async function run() {
    if (!window.confirm("Delete this post from the Library? The image file stays on disk; its captions, tags and renditions go away.")) return;
    setBusy(true);
    const res = await fetch("/api/posts/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-rsr": "1" },
      body: JSON.stringify({ id: props.id }),
    });
    if (res.ok) window.location.reload();
    else { setBusy(false); window.alert(`Delete failed (HTTP ${res.status}).`); }
  }
  return <button className="secondary" disabled={busy} onClick={() => void run()} aria-label={`Delete post ${props.id}`}>Delete</button>;
}
