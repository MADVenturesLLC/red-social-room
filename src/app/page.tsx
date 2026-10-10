import CreateClient from "../components/CreateClient.tsx";
import { getApp } from "../server/app.ts";
import { appStatus } from "../server/status.ts";
import { listSnippets, recentPrompts, reuseData } from "../server/library.ts";
import { CAPABILITIES as XAI_CAPS } from "../server/xai/adapter.ts";
import { CAPABILITIES as GOOGLE_CAPS } from "../server/google/adapter.ts";

export const dynamic = "force-dynamic";

export default async function CreatePage({ searchParams }: { searchParams: Promise<{ reuse?: string | string[] }> }) {
  const sp = await searchParams;
  const reuseId = typeof sp.reuse === "string" ? sp.reuse : "";
  const app = getApp();
  const s = appStatus(app);
  // The picker offers ratios both creators can make (A2: one prompt goes to every chosen card).
  const ratios = XAI_CAPS.pickerRatios.filter((r) => (GOOGLE_CAPS.ratios as readonly string[]).includes(r));
  // A7: reuse a Library post (prompt + model prefilled) and the snippet chips under the prompt box.
  const prefill = reuseId ? reuseData(app.db, reuseId) : null;
  const recent = recentPrompts(app.db);
  const snippets = listSnippets(app.db);
  return (
    <>
      <h1>Create</h1>
      <CreateClient ratios={ratios} creators={s.creators} warn={s.totals.warn}
        totalsText={`${s.totalsText.counted} counted of ${s.totalsText.cap} cap${s.totals.heldMicros > 0 ? ` (incl. ${s.totalsText.held} held for unchecked calls)` : ""}`}
        prefill={prefill} recent={recent} snippets={snippets} />
    </>
  );
}
