import { getApp } from "../../server/app.ts";
import { appStatus } from "../../server/status.ts";
import { unresolvedRows, unresolvedHeldText, fmtUsd, googleConsoleState } from "../../server/ledger.ts";
import { freeBytes } from "../../server/store.ts";
import { KeyForm, GoogleKeyForm, CheckButton, CapForm, ReconcileRow, ConsoleForm } from "../../components/SettingsClient.tsx";

export const dynamic = "force-dynamic";

const LOW_DISK_BYTES = 10e9; // Amendment 1 F16: warn below 10 GB

export default function SettingsPage() {
  const app = getApp();
  const s = appStatus(app);
  const unresolved = unresolvedRows(app.db);
  const gc = googleConsoleState(app.db);
  const free = freeBytes(app.imagesDir.replace(/\/images$/, ""));
  return (
    <>
      <h1>Settings</h1>
      <section className="card">
        <h2>xAI key</h2>
        <p data-testid="key-status">
          {s.key.set ? <>Set ({s.key.source === "settings" ? "saved here" : "from .env"}), ending <code>{s.key.last4 ?? "????"}</code>.</> : "Not set."}{" "}
          {s.key.checked ? (s.key.checkOk ? `Key check passed${s.key.versionListing ? ` (model ${s.key.versionListing}, from listing)` : ""}.` : (s.key.checkMessage ?? "Key check failed.")) : "Not checked yet."}
        </p>
        <p className="muted">The key stays on the server. It is never shown again after you save it; only its last 4 characters appear here.</p>
        <KeyForm />
        <CheckButton />
      </section>
      <section className="card">
        <h2>Google key</h2>
        <p data-testid="google-key-status">
          {s.googleKey.set ? <>Set ({s.googleKey.source === "settings" ? "saved here" : "from .env"}), ending <code>{s.googleKey.last4 ?? "????"}</code>.</> : "Not set."}{" "}
          {s.googleKey.checked ? (s.googleKey.checkOk ? `Key check passed${s.googleKey.versionListing ? ` (${s.googleKey.versionListing})` : ""}.` : (s.googleKey.checkMessage ?? "Key check failed.")) : "Not checked yet."}
        </p>
        <p className="muted">Stays on the server; only the last 4 characters appear here. Google returns no billed amount, so the app estimates each call from the token counts it reports; the Google console check below shows the difference.</p>
        <GoogleKeyForm />
      </section>
      <section className="card">
        <h2>Spend ({s.totals.monthNY}, America/New_York month)</h2>
        <p>{s.totalsText.counted} counted of {s.totalsText.cap} cap{s.totals.heldMicros > 0 ? `, including ${s.totalsText.held} held for unchecked calls` : ""}.</p>
        <p className="muted">By provider: {Object.entries(s.totals.byProvider).map(([p, m]) => `${p} ${fmtUsd(m)}`).join(", ") || "none"}</p>
        {s.totals.warn ? <p className="warn">Spend is at 80% or more of the cap.</p> : null}
        <CapForm capUsd={s.totals.capMicros / 1e6} />
        {s.priceDrift.length > 0 ? (
          <div data-testid="price-drift">
            <h3>Price drift ({s.priceDrift.length})</h3>
            {s.priceDrift.map((d) => <p key={d.ledgerId} className="warn">{d.at}: {d.text}</p>)}
          </div>
        ) : null}
        <h3>Unresolved ({unresolved.length})</h3>
        <p className="muted">Calls that may have been charged. Each stays held against the cap until you check it against the provider console. Not charged drops the hold; the charged amount settles the row by hand — the original numbers are never rewritten.</p>
        <table><tbody>
          {unresolved.map((r) => <tr key={r.id}><td>{r.created_at}</td><td>{r.provider}</td><td>Ref {r.id.slice(0, 8)}</td><td>{unresolvedHeldText(r)}</td><td>HTTP {r.http_status ?? "—"}</td><td><ReconcileRow id={r.id} /></td></tr>)}
        </tbody></table>
        <h3>Google console total ({gc.monthNY})</h3>
        <p className="muted" data-testid="google-console">
          App estimate for Google this month: {fmtUsd(gc.estimateMicros)}{gc.appliedMicros > 0 ? ` (plus ${fmtUsd(gc.appliedMicros)} adjustment already applied)` : ""}.{" "}
          {gc.consoleMicros === null ? `Enter Google console total for ${gc.monthNY} from Google Cloud Billing to check it.` : `Console total on record: ${fmtUsd(gc.consoleMicros)}; difference ${fmtUsd(gc.differenceMicros ?? 0)}.`}
        </p>
        <ConsoleForm monthNY={gc.monthNY} />
      </section>
      <section className="card">
        <h2>Storage</h2>
        <p className={free !== null && free < LOW_DISK_BYTES ? "warn" : "muted"}>{free === null ? "Free space unknown." : `${(free / 1e9).toFixed(1)} GB free in the data folder${free < LOW_DISK_BYTES ? " (below 10 GB)" : ""}.`}</p>
      </section>
      <section className="card">
        <h2>About</h2>
        <p className="muted">{app.switches.xaiDataRetention === "zdr" ? "xAI zero data retention is on (set in the xAI console); the app logs xAI's x-zero-data-retention header on each call." : "xAI keeps requests 30 days for abuse review."}</p>
        <p className="muted">Real-person check: name list (config/real-person-names.txt); {app.switches.promptCheck.onFailure === "block" ? "if it can't run, nothing is sent" : "if it can't run, prompts are sent and labeled"}.</p>
        <p className="muted">Google calls are sent with store:false; the app never keeps the raw response, only the image and the token counts.</p>
      </section>
    </>
  );
}
