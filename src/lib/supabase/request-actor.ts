/**
 * WHO IS WRITING — the signed-in person of the request being served, sent with every database write so
 * the history triggers can name them (code review, 14 Nov 2026).
 *
 * The employee change log and the salary change log read the actor from the x-phoenix-actor-login-id /
 * x-phoenix-actor-hr-id request headers (current_setting('request.headers')). Only upsertEmployee used to
 * send them, so a manager moved by a resignation, a probation decision, an import or a photo upload was
 * logged "unattributed". Now the access resolvers (src/lib/auth/server.ts) remember the person once per
 * request, and the shared admin client (./server.ts) and the employee REST helpers add the headers to
 * every write they make while that request is served.
 *
 * Keyed on the request's own header store from next/headers — one object per request, so a person is
 * never carried into another request. Outside a request (a cron, a script, a test, a timer) there is no
 * store, nothing is remembered and nothing is sent: the write is recorded unattributed, as before.
 * A View as Seat or a test account is never remembered: neither writes as the person it shows.
 */

type RequestActor = { loginId: string | null; hrId: string | null };

type ActorSource = {
  loginId?: string | null;
  hrId?: string | null;
  source: string;
  seatView?: unknown;
  testPersona?: unknown;
};

const actors = new WeakMap<object, RequestActor>();

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
}

/** The x-phoenix-actor-* headers for the request whose header store is `store`; empty when none. */
export function actorHeadersFor(store: object | null): Record<string, string> {
  const actor = store ? actors.get(store) : undefined;
  const out: Record<string, string> = {};
  if (actor?.loginId) out["x-phoenix-actor-login-id"] = actor.loginId;
  if (actor?.hrId) out["x-phoenix-actor-hr-id"] = actor.hrId;
  return out;
}

/** Called by the access resolvers once they know who is signed in. Never throws. */
export async function rememberRequestActor(access: ActorSource): Promise<void> {
  if (access.source !== "session" && access.source !== "dev-header") return;
  rememberActorFor(await currentRequestStore(), access);
}

/** The headers to add to a database write made while serving the current request. Never throws. */
export async function requestActorHeaders(): Promise<Record<string, string>> {
  return actorHeadersFor(await currentRequestStore());
}
