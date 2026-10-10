import { getApp } from "../../server/app.ts";
import { searchPosts } from "../../server/library.ts";

export const dynamic = "force-dynamic";

export default async function LibraryPage({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q : "";
  const posts = searchPosts(getApp().db, q);
  return (
    <>
      <h1>Library</h1>
      <form method="get" action="/library" className="row">
        <input type="search" name="q" defaultValue={q} placeholder="Search by a word from the prompt" aria-label="Search" />
        <button type="submit">Search</button>
      </form>
      <p className="muted">{posts.length} {posts.length === 1 ? "image" : "images"}{q ? ` matching “${q}”` : ""}</p>
      <div className="grid">
        {posts.map((p) => (
          <figure key={p.id} className="card" style={{ margin: 0 }} data-post-id={p.id}>
            <a href={`/api/assets/${p.asset_id}`}><img src={`/api/assets/${p.asset_id}`} alt={p.prompt} loading="lazy" width={p.width ?? undefined} height={p.height ?? undefined} /></a>
            <figcaption className="muted">{p.prompt}{p.notes ? ` — ${p.notes}` : ""}<br />{p.model} · {p.created_at.slice(0, 10)} · <a href={`/design/${p.id}`}>{p.designed ? "Edit design" : "Design"}</a></figcaption>
          </figure>
        ))}
      </div>
    </>
  );
}
