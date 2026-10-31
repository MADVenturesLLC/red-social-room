"use client";
// C1: share one library image (with its prompt as the message) through the phone's share sheet.
import { useState } from "react";
import { shareImage } from "../lib/share.ts";

export default function ShareAssetButton({ assetId, prompt, filename }: { assetId: string; prompt: string; filename: string }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <button
        type="button"
        className="linkish"
        data-share-asset={assetId}
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setMsg(null);
          void shareImage(`/api/assets/${assetId}`, filename, "Red Social Room", prompt).then((out) => {
            setBusy(false);
            if (out === "downloaded") setMsg("No share sheet here — downloaded it.");
            else if (out === "failed") setMsg("Sharing failed — open the image and save it.");
          });
        }}
      >
        {busy ? "Preparing…" : "Share"}
      </button>
      {msg ? <span className="muted mini"> {msg}</span> : null}
    </>
  );
}
