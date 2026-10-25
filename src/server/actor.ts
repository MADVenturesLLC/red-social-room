// B1 "Who's using it": the app reads the signed-in person from Cloudflare Access.
// Access sets Cf-Access-Authenticated-User-Email on every request that passed the Access gate, and it
// blocks outsiders from spoofing that header (the origin is only reachable through the tunnel). A request
// with no header comes from the box itself or the tailnet, and counts as the owner.
//
// The allowlist lives in config/users.json. Both allowlisted accounts may make paid calls; any other
// account that ever signs in is view-only, enforced on the server (spendDenied), not just in the UI.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./config.ts";

export const ACCESS_EMAIL_HEADER = "cf-access-authenticated-user-email";

export interface AppUser {
  email: string;
  name: string;
  role: string | null;
  canSpend: boolean;
  /** Owner/admin: settings, keys, the cap, deletions and backups. Michael only. */
  isOwner: boolean;
}

export interface Actor {
  email: string | null;
  name: string;
  role: string | null;
  canSpend: boolean;
  isOwner: boolean;
  /** access = a person signed in at the Cloudflare door; local = the owner on the box/tailnet; unknown = a
   *  signed-in account that is not on the allowlist (view-only). */
  via: "access" | "local" | "unknown";
}

export interface UsersConfig {
  users: AppUser[];
  localOwnerEmail: string;
}

export class UsersConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsersConfigError";
  }
}

let cached: UsersConfig | null = null;

/** Validate a parsed config/users.json body. Pure, so tests can prove the failure paths. */
export function loadUsersFrom(raw: unknown): UsersConfig {
  const o = (raw && typeof raw === "object" ? raw : {}) as { users?: unknown; localOwnerEmail?: unknown };
  const rows = Array.isArray(o.users) ? o.users : [];
  const users: AppUser[] = [];
  for (const row of rows) {
    const u = (row && typeof row === "object" ? row : {}) as Record<string, unknown>;
    const email = typeof u.email === "string" ? u.email.trim().toLowerCase() : "";
    const name = typeof u.name === "string" ? u.name.trim() : "";
    if (!email || !name) throw new UsersConfigError("Every user in config/users.json needs an email and a name.");
    users.push({
      email,
      name,
      role: typeof u.role === "string" && u.role.trim() ? u.role.trim() : null,
      canSpend: u.canSpend === true,
      isOwner: u.isOwner === true,
    });
  }
  if (!users.length) throw new UsersConfigError("config/users.json lists no users.");
  const owner = typeof o.localOwnerEmail === "string" ? o.localOwnerEmail.trim().toLowerCase() : users[0].email;
  if (!users.some((u) => u.email === owner)) throw new UsersConfigError("localOwnerEmail in config/users.json is not one of the users.");
  if (!users.some((u) => u.isOwner)) throw new UsersConfigError("config/users.json has no owner (isOwner: true).");
  return { users, localOwnerEmail: owner };
}

/** Load and validate config/users.json once. getApp() calls this at startup, so a broken file stops the app. */
export function loadUsers(): UsersConfig {
  if (cached) return cached;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(/*turbopackIgnore: true*/ REPO_ROOT, "config", "users.json"), "utf8"));
  } catch {
    throw new UsersConfigError("config/users.json could not be read.");
  }
  cached = loadUsersFrom(raw);
  return cached;
}

/** Pure mapping from the request's header getter to the person using the app. */
export function actorFromHeaders(get: (name: string) => string | null, cfg: UsersConfig = loadUsers()): Actor {
  const raw = get(ACCESS_EMAIL_HEADER);
  const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!email) {
    const owner = cfg.users.find((u) => u.email === cfg.localOwnerEmail) as AppUser;
    return { email: owner.email, name: owner.name, role: owner.role, canSpend: owner.canSpend, isOwner: owner.isOwner, via: "local" };
  }
  const user = cfg.users.find((u) => u.email === email);
  if (user) return { email: user.email, name: user.name, role: user.role, canSpend: user.canSpend, isOwner: user.isOwner, via: "access" };
  return { email, name: email, role: null, canSpend: false, isOwner: false, via: "unknown" };
}

export function actorFromRequest(req: Request, cfg: UsersConfig = loadUsers()): Actor {
  return actorFromHeaders((name) => req.headers.get(name), cfg);
}

/** "Michael (Founder)" — what the header shows. */
export function signedInText(a: Actor): string {
  return `${a.name}${a.role ? ` (${a.role})` : ""}`;
}

/**
 * B1: a view-only account gets no paid call. Returns the refusal response, or null when the call may run.
 * Every spend route calls this before doing any work, so the gate does not depend on the UI.
 */
export function spendDenied(actor: Actor): Response | null {
  if (actor.canSpend) return null;
  return new Response(
    JSON.stringify({ error: `This account is view-only (${actor.name}). Model calls are off for it; ask Michael to allowlist the account.` }),
    { status: 403, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } }
  );
}

/**
 * B1 (review round): settings, keys, the monthly cap, post deletion and backups are the owner's. A view-only
 * account, and Stephanie's spending account alike, cannot change the conditions under which money is spent.
 * Content actions (upload, save, design, export, snippets, tags) stay available to every signed-in account.
 */
export function ownerDenied(actor: Actor): Response | null {
  if (actor.isOwner) return null;
  return new Response(
    JSON.stringify({ error: `This account can't change settings or delete data (${actor.name}). Ask Michael to make the change.` }),
    { status: 403, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } }
  );
}
