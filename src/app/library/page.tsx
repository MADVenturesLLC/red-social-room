import { getApp } from "../../server/app.ts";
import { listTags, searchPosts } from "../../server/library.ts";
import DeletePostButton from "../../components/DeletePostButton.tsx";
import ShareAssetButton from "../../components/ShareAssetButton.tsx";

export const dynamic = "force-dynamic";

export default async function LibraryPage({ searchParams }: { searchParams: Promise<{ q?: string | string[]; tag?: string | string[] }> }) {
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q : "";
  const tag = typeof sp.tag === "string" ? sp.tag : "";
  const db = getApp().db;
  const tags = listTags(db);
  const posts = searchPosts(db, q, tag);

  // One query for the tags of the shown posts (A7: they are listed under each card).
  const tagsOf = new Map<number, string[]>();
  if (posts.length > 0) {
    const marks = posts.map(() => "?").join(",");
    const rows = db.prepare(`SELECT pt.post_id AS pid, t.name AS name FROM post_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.post_id IN (${marks}) ORDER BY t.name`).all(...posts.map((p) => p.id)) as unknown as Array<{ pid: number; name: string }>;
    for (const r of rows) tagsOf.set(Number(r.pid), [...(tagsOf.get(Number(r.pid)) ?? []), r.name]);
  }

  const qs = (t: string | null) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (t) params.set("tag", t);
    const s = params.toString();
    return `/library${s ? `?${s}` : ""}`;
  };

  return (
    <>
      <h1>Library</h1>
      <form method="get" action="/library" className="row">
        <input type="search" name="q" defaultValue={q} placeholder="Search by a word from the prompt" aria-label="Search" />
        {tag ? <input type="hidden" name="tag" value={tag} /> : null}
        <button type="submit">Search</button>
      </form>
      {tags.length > 0 ? (
        <div className="row" data-testid="tag-filters">
          <span className="muted">Tags:</span>
          <a className={tag ? "secondary" : ""} href={qs(null)} data-active={!tag ? "1" : undefined}>All</a>
          {tags.map((t) => (
            <a key={t.name} className={t.name === tag ? "" : "secondary"} href={qs(t.name)} data-tag={t.name} data-active={t.name === tag ? "1" : undefined}>
              {t.name} ({t.count})
            </a>
          ))}
        </div>
      ) : null}
      <p className="muted">{posts.length} {posts.length === 1 ? "image" : "images"}{q ? ` matching “${q}”` : ""}{tag ? ` tagged “${tag}”` : ""}</p>
      <div className="grid">
        {posts.map((p) => (
          <figure key={p.id} className="card" style={{ margin: 0 }} data-post-id={p.id}>
            <a href={`/api/assets/${p.asset_id}`}><img src={`/api/assets/${p.asset_id}`} alt={p.prompt} loading="lazy" width={p.width ?? undefined} height={p.height ?? undefined} /></a>
            <figcaption className="muted">
              {p.prompt}{p.notes ? ` — ${p.notes}` : ""}<br />
              {p.model} · {p.created_at.slice(0, 10)}{p.created_by ? ` · by ${p.created_by}` : ""}
              {tagsOf.get(p.id)?.length ? <> · {tagsOf.get(p.id)!.map((t) => <span key={t} className="tag">{t}</span>)}</> : null}
              <br />
              <a href={`/design/${p.id}`}>{p.designed ? "Edit design" : "Design"}</a> · <a href={`/captions/${p.id}`}>Captions</a> · <a href={`/export/${p.id}`}>Export</a> · <a href={`/?reuse=${p.id}`}>Reuse</a>
              {" "}<ShareAssetButton assetId={p.asset_id} prompt={p.prompt} filename={`rsr-${p.id}.jpg`} />
              {" "}<DeletePostButton id={p.id} />
            </figcaption>
          </figure>
        ))}
      </div>
    </>
  );
}
