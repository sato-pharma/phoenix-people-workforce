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
 * inside a real Next request scope). Outside a request (a script, a test, a timer) there is no store,
 * nothing is remembered and nothing is sent: the write is recorded unattributed, as before.
 *
 * A SCHEDULED JOB NAMES ITSELF (owner, 19 Nov 2026: "Name scheduled jobs"). A cron route has no
 * signed-in person, so its writes used to read "No person recorded" on the Employee Master's Change
 * History. Every scheduled route already names itself to the shared cron guard
 * (src/lib/security/cron-auth.ts: assertCronAuthorized(request, "cron/probation-milestones")); once the
 * guard lets it in, it calls rememberRequestJob, and that request's writes carry
 * x-phoenix-actor-job: <the name>. The two logs store it as actor_job, actor_source 'job'. The same
 * limits hold: only /rest/v1 writes carry it, a caller that names any actor header is left alone, and
 * a person always wins — when someone is signed in to the request, their headers go and the job's
 * does not. The first name a request is given is kept: the morning fan-out runs other routes' handlers
 * inside its own request, and a run is named by the route that started it.
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

const JOB_HEADER = "x-phoenix-actor-job";

const ACTOR_HEADER_NAMES = ["x-phoenix-actor-login-id", "x-phoenix-actor-hr-id", JOB_HEADER] as const;

const actors = new WeakMap<object, RequestActor>();

/** The scheduled job serving a request, by the request's header store. */
const jobs = new WeakMap<object, string>();

// A job is remembered from the cron guard, which answers synchronously, so the store is looked up in
// the background. A write waits for every lookup still in flight before it reads, so a job's first
// write can never go out ahead of its name.
const jobsBeingRemembered = new Set<Promise<void>>();

// The database stores at most 100 characters; a route name is far shorter.
const JOB_NAME_MAX = 100;

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

/** Remember `job` as the scheduled job serving the request whose header store is `store`. The first name stays. */
export function rememberJobFor(store: object | null, job: string): void {
  if (!store) return;
  const name = clean(job);
  if (!name || name.length > JOB_NAME_MAX) return;
  if (!jobs.has(store)) jobs.set(store, name);
  anyoneRemembered = true;
}

/**
 * The x-phoenix-actor-* headers for the request whose header store is `store`; empty when none. The
 * signed-in person when there is one, else the scheduled job — never both.
 */
export function actorHeadersFor(store: object | null): Record<string, string> {
  const actor = store ? actors.get(store) : undefined;
  const out: Record<string, string> = {};
  if (actor?.loginId) out["x-phoenix-actor-login-id"] = actor.loginId;
  if (actor?.hrId) out["x-phoenix-actor-hr-id"] = actor.hrId;
  if (Object.keys(out).length > 0) return out;
  const job = store ? jobs.get(store) : undefined;
  if (job) out[JOB_HEADER] = job;
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

/**
 * Called by the shared cron guard once it has let a scheduled job in: that request's writes are logged
 * under the job's name. Returns at once and never throws; the lookup finishes in the background, and
 * requestActorHeaders waits for it.
 */
export function rememberRequestJob(job: string): void {
  const name = clean(job);
  if (!name || name.length > JOB_NAME_MAX) return;
  const lookup: Promise<void> = currentRequestStore()
    .then((store) => rememberJobFor(store, name))
    .finally(() => {
      jobsBeingRemembered.delete(lookup);
    });
  jobsBeingRemembered.add(lookup);
}

/** The headers to add to `call`, made while serving the current request. Empty for anything else. Never throws. */
export async function requestActorHeaders(call: DatabaseCall): Promise<Record<string, string>> {
  if (jobsBeingRemembered.size > 0) await Promise.all([...jobsBeingRemembered]);
  if (!anyoneRemembered || !callTakesRequestActor(call)) return {};
  return actorHeadersFor(await currentRequestStore());
}
