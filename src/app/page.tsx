import CreateClient from "../components/CreateClient.tsx";
import { getApp } from "../server/app.ts";
import { appStatus } from "../server/status.ts";
import { CAPABILITIES } from "../server/xai/adapter.ts";

export const dynamic = "force-dynamic";

export default function CreatePage() {
  const s = appStatus(getApp());
  return (
    <>
      <h1>Create</h1>
      <CreateClient ratios={CAPABILITIES.pickerRatios} priceText={s.creator.priceText} stateText={s.creator.stateText} ready={s.creator.state === "ready" || s.creator.state === "key_unchecked"} warn={s.totals.warn}
        totalsText={`${s.totalsText.counted} counted of ${s.totalsText.cap} cap${s.totals.heldMicros > 0 ? ` (incl. ${s.totalsText.held} held for unchecked calls)` : ""}`} />
    </>
  );
}
