import CreateClient from "../components/CreateClient.tsx";
import { getApp } from "../server/app.ts";
import { appStatus } from "../server/status.ts";
import { CAPABILITIES as XAI_CAPS } from "../server/xai/adapter.ts";
import { CAPABILITIES as GOOGLE_CAPS } from "../server/google/adapter.ts";

export const dynamic = "force-dynamic";

export default function CreatePage() {
  const s = appStatus(getApp());
  // The picker offers ratios both creators can make (A2: one prompt goes to every chosen card).
  const ratios = XAI_CAPS.pickerRatios.filter((r) => (GOOGLE_CAPS.ratios as readonly string[]).includes(r));
  return (
    <>
      <h1>Create</h1>
      <CreateClient ratios={ratios} creators={s.creators} warn={s.totals.warn}
        totalsText={`${s.totalsText.counted} counted of ${s.totalsText.cap} cap${s.totals.heldMicros > 0 ? ` (incl. ${s.totalsText.held} held for unchecked calls)` : ""}`} />
    </>
  );
}
