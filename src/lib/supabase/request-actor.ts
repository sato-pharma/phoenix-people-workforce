/**
 * WHO IS WRITING — the signed-in person of the request being served, sent with every database write so
 * the history triggers can name them (code review, 14 Nov 2026).
 *
 * The employee change log, the salary change log and the deduction decision history read the actor from
 * the x-phoenix-actor-login-id / x-phoenix-actor-hr-id request headers
 * (current_setting('request.headers')). Only upsertEmployee used to send them, so a manager moved by a
 * resignation, a probation decision, an import or a photo upload was logged "unattributed". Now the
 * access resolvers (src/lib/auth/server.ts) remember the person once per request, and the shared admin
 * client (./server.ts) and the employee REST helpers add the headers to the database writes they make
 * while that request is served.
 *
 * FOUR LIMITS, each on purpose:
 *   - Only a request that CAN write is remembered: an API call that is not a GET or HEAD, a server
 *     action, a posted form. A sync that runs while someone merely opens a page is nobody's decision,
 *     and is logged unattributed, never as the reader's (the resolvers decide this).
 *   - Only a database write carries it: a /rest/v1 call that is not a GET or HEAD. Storage, auth and
 *     edge functions never read these headers, so they are never sent them.
 *   - A caller that names an actor itself — either header — is left exactly as it is. Two sources are
 *     never mixed into one actor.
 *   - A View as Seat or a test account is never remembered: neither writes as the person it shows.
 *
 * Keyed on the request's own header store from next/headers — one object per request, so a person is
 * never carried into another request (tests/employee-and-deduction-history.test.ts proves the identity
 * inside a real Next request scope). Outside a request (a cron, a script, a test, a timer) there is no
 * store, nothing is remembered and nothing is sent: the write is recorded unattributed, as before.
 */

type RequestActor = { loginId: string | null; hrId: string | null };

type ActorSource = {
  loginId?: string | null;
  hrId?: string | null;
  source: string;
  seatView?: unknown;
  testPersona?: unknown;
};

/** The one call being made: its method, its URL when the caller did not build it itself, its own headers. */
type DatabaseCall = { method?: string | null; url?: string | null; headers?: HeadersInit };

const ACTOR_HEADER_NAMES = ["x-phoenix-actor-login-id", "x-phoenix-actor-hr-id"] as const;

const actors = new WeakMap<object, RequestActor>();

// Nobody remembered in this process yet → no write asks Next for anything. A script, a build, the test
// suite and a cron-only worker never pay for a header read, and never call headers() where it would
// throw or mark a static render dynamic.
let anyoneRemembered = false;

// A header value must be visible ASCII; HR ids and login ids already are (e.g. "B-10").
const HEADER_SAFE = /^[\x21-\x7e]+$/;

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && HEADER_SAFE.test(trimmed) ? trimmed : null;
}

/** The header store of the request being served, or null outside one. Never throws. */
async function currentRequestStore(): Promise<object | null> {
  try {
    const { headers } = await import("next/headers");
    const store = await headers();
    return store && typeof store === "object" ? store : null;
  } catch {
    return null;
  }
}

/** Remember `access` as the writer for the request whose header store is `store`. */
export function rememberActorFor(store: object | null, access: ActorSource): void {
  if (!store) return;
  if (access.source !== "session" && access.source !== "dev-header") return;
  if (access.seatView || access.testPersona) return;
  const actor = { loginId: clean(access.loginId), hrId: clean(access.hrId) };
  if (!actor.loginId && !actor.hrId) return;
  actors.set(store, actor);
  anyoneRemembered = true;
}

/** The x-phoenix-actor-* headers for the request whose header store is `store`; empty when none. */
export function actorHeadersFor(store: object | null): Record<string, string> {
  const actor = store ? actors.get(store) : undefined;
  const out: Record<string, string> = {};
  if (actor?.loginId) out["x-phoenix-actor-login-id"] = actor.loginId;
  if (actor?.hrId) out["x-phoenix-actor-hr-id"] = actor.hrId;
  return out;
}

/** Whether this call is a database write that named no actor of its own. Reads nothing but the call. */
export function callTakesRequestActor(call: DatabaseCall): boolean {
  const method = (call.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return false;
  if (call.url != null && !call.url.includes("/rest/v1/")) return false;
  const named = new Headers(call.headers);
  return !ACTOR_HEADER_NAMES.some((name) => named.has(name));
}

/** `init` with the actor headers laid on top; `init` itself when there are none. Nothing else is touched. */
export function withActorHeaders(init: RequestInit | undefined, actor: Record<string, string>): RequestInit | undefined {
  const entries = Object.entries(actor);
  if (entries.length === 0) return init;
  const merged = new Headers(init?.headers);
  for (const [name, value] of entries) merged.set(name, value);
  return { ...init, headers: merged };
}

/** Called by the access resolvers, for a request that can write, once they know who is signed in. Never throws. */
export async function rememberRequestActor(access: ActorSource): Promise<void> {
  if (access.source !== "session" && access.source !== "dev-header") return;
  rememberActorFor(await currentRequestStore(), access);
}

/** The headers to add to `call`, made while serving the current request. Empty for anything else. Never throws. */
export async function requestActorHeaders(call: DatabaseCall): Promise<Record<string, string>> {
  if (!anyoneRemembered || !callTakesRequestActor(call)) return {};
  return actorHeadersFor(await currentRequestStore());
}
