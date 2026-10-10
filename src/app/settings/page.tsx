import { getApp } from "../../server/app.ts";
import { appStatus } from "../../server/status.ts";
import { unresolvedRows, unresolvedHeldText, fmtUsd, googleConsoleState } from "../../server/ledger.ts";
import { freeBytes } from "../../server/store.ts";
import { backupSummary } from "../../server/backup.ts";
import { r2Status } from "../../server/r2config.ts";
import { maintenanceRows } from "../../server/fts.ts";
import { KeyForm, GoogleKeyForm, CheckButton, CapForm, ReconcileRow, ConsoleForm, R2Form, BackupNowButton, FtsTools } from "../../components/SettingsClient.tsx";

export const dynamic = "force-dynamic";

const LOW_DISK_BYTES = 10e9; // Amendment 1 F16: warn below 10 GB

function ageText(ms: number | null): string {
  if (ms === null) return "never";
  const h = ms / 3.6e6;
  return h < 1 ? `${Math.max(1, Math.round(ms / 6e4))} min ago` : h < 48 ? `${h.toFixed(1)} h ago` : `${(h / 24).toFixed(1)} days ago`;
}

export default function SettingsPage() {
  const app = getApp();
  const s = appStatus(app);
  const unresolved = unresolvedRows(app.db);
  const gc = googleConsoleState(app.db);
  const free = freeBytes(app.imagesDir.replace(/\/images$/, ""));
  const r2 = r2Status(app.db, app.dataDir);
  const backups = backupSummary(app.db, new Date());
  const backupRows = app.db.prepare("SELECT started_at, ok, error, files_uploaded, bytes_uploaded FROM backups ORDER BY id DESC LIMIT 5").all() as unknown as Array<{ started_at: string; ok: number | null; error: string | null; files_uploaded: number; bytes_uploaded: number }>;
  const maintenance = maintenanceRows(app.db, 5);
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
      <section className="card" data-testid="backup">
        <h2>Backup (nightly to Cloudflare R2)</h2>
        {backups.banner ? (
          <p className="error" data-testid="backup-banner">
            {backups.never
              ? "No good backup yet — set the target below and run the first one."
              : `Last good backup was ${ageText(backups.staleMs)} — that is over 48 hours. Check the target.`}
          </p>
        ) : (
          <p className="muted" data-testid="backup-banner-ok">Last good backup: {ageText(backups.staleMs)}.</p>
        )}
        <p className="muted">Runs by itself every night around 3 AM New York, and whenever you press Back up now. Each run snapshots the database, uploads only new image files, and leaves a manifest that the restore drill reads.</p>
        {backupRows.length > 0 ? (
          <table><tbody>
            {backupRows.map((r, i) => <tr key={i}><td>{r.started_at}</td><td>{r.ok === 1 ? "ok" : r.ok === 0 ? "failed" : "running"}</td><td>{r.ok === 1 ? `${r.files_uploaded} file(s), ${(r.bytes_uploaded / 1e6).toFixed(1)} MB` : (r.error ?? "")}</td></tr>)}
          </tbody></table>
        ) : null}
        <BackupNowButton />
        <h3>Target</h3>
        <p className="muted" data-testid="r2-status">
          {r2.configured
            ? <>Set: <code>{r2.bucket}</code> at <code>{r2.endpoint}</code>{r2.keyLast4 ? ` (key ending ${r2.keyLast4})` : ""}.</>
            : "Not set yet. Create an R2 bucket in Cloudflare, then an R2 API token with Object Read & Write for it, and paste the four values below."}
        </p>
        <R2Form configured={r2.configured} endpoint={r2.endpoint} bucket={r2.bucket} keyLast4={r2.keyLast4} />
      </section>
      <section className="card" data-testid="search-index">
        <h2>Search index</h2>
        <p className="muted">Checked once a night: the index is compared with the posts table and rebuilt automatically if they differ (nothing for you to do). The buttons are here for peace of mind.</p>
        {maintenance.length > 0 ? (
          <table><tbody>
            {maintenance.map((m) => <tr key={m.id}><td>{m.created_at}</td><td>{m.kind}</td><td className="muted">{m.detail.slice(0, 120)}</td></tr>)}
          </tbody></table>
        ) : null}
        <FtsTools />
      </section>
      <section className="card">
        <h2>Storage</h2>
        <p className={free !== null && free < LOW_DISK_BYTES ? "warn" : "muted"}>{free === null ? "Free space unknown." : `${(free / 1e9).toFixed(1)} GB free in the data folder${free < LOW_DISK_BYTES ? " (below 10 GB)" : ""}.`}</p>
      </section>
      <section className="card">
        <h2>About</h2>
        <p className="muted">{app.switches.xaiDataRetention === "zdr" ? "xAI zero data retention is on (set in the xAI console); the app logs xAI's x-zero-data-retention header on each call." : "xAI keeps requests 30 days for abuse review."}</p>
        <p className="muted">Real-person check: name list (config/real-person-names.txt); {app.switches.promptCheck.onFailure === "block" ? "if it can't run, nothing is sent" : "if prompts can't be checked, they are sent and labeled"}.</p>
        <p className="muted">Google calls are sent with store:false; the app never keeps the raw response, only the image and the token counts.</p>
      </section>
    </>
  );
}
