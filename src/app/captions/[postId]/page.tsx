// A5: the captions page (T:99, T:214-216). Server component: loads the post's final image, its saved
// captions and tags, the brand voice text, and the platform/tone presets from config.
import { notFound } from "next/navigation";
import { getApp } from "../../../server/app.ts";
import { getPostDesign } from "../../../server/design.ts";
import { getBrandVoice, listCaptions, listPostTags, loadPlatforms, loadTones } from "../../../server/captions.ts";
import CaptionsClient from "../../../components/CaptionsClient.tsx";

export const dynamic = "force-dynamic";

export default async function CaptionsPage({ params }: { params: Promise<{ postId: string }> }) {
  const { postId } = await params;
  const app = getApp();
  const post = getPostDesign(app.db, postId);
  if (!post) notFound();
  return (
    <>
      <h1>Captions <span className="muted mini">{post.prompt}</span></h1>
      <p className="muted">One click writes two caption options per platform, with hashtags and alt text — each counted against that platform’s limit, and anything over it is flagged, never cut. The image, your prompt, the tone, your notes and your brand voice all ride along.</p>
      <CaptionsClient
        post={{ id: post.id, prompt: post.prompt, assetId: post.assetId }}
        captions={listCaptions(app.db, post.id)}
        tags={listPostTags(app.db, post.id)}
        brandVoice={getBrandVoice(app.db)}
        platforms={[...loadPlatforms()]}
        tones={[...loadTones()]}
      />
    </>
  );
}
