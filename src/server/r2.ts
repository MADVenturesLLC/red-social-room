// A7 (FD:6): a minimal S3 client for Cloudflare R2, signed with SigV4 by aws4fetch (pinned 1.0.20).
// Only the backup engine talks to it; tests inject their own ObjectStore, so no test ever reaches the
// network. Keys never appear in errors: a failed call reports the HTTP status and a short body excerpt.
import { AwsClient } from "aws4fetch";
import type { R2Config } from "./r2config.ts";

export interface ObjectStore {
  put(key: string, body: Uint8Array, contentType?: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
}

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,300}$/;

export function assertObjectKey(key: string): void {
  if (!KEY_RE.test(key) || key.includes("..") || key.includes("//")) throw new Error(`bad object key: ${key.slice(0, 80)}`);
}

export function r2Store(cfg: R2Config, fetchImpl: typeof fetch = fetch): ObjectStore {
  const client = new AwsClient({ accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, service: "s3", region: "auto" });
  const url = (key: string) => `${cfg.endpoint}/${cfg.bucket}/${key}`;
  return {
    async put(key, body, contentType = "application/octet-stream") {
      assertObjectKey(key);
      const res = await client.fetch(url(key), { method: "PUT", body: new Uint8Array(body), headers: { "content-type": contentType } });
      if (!res.ok) throw new Error(`R2 refused the upload of ${key} (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
    },
    async get(key) {
      assertObjectKey(key);
      const res = await client.fetch(url(key), { method: "GET" });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`R2 refused to read ${key} (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}
