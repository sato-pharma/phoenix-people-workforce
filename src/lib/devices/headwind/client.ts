/**
 * The one HTTP path to the company's Headwind MDM server.
 *
 * Every device read and every remote action goes through `callHeadwind`, so the bearer header, the
 * base address, the JSON handling and the error shape are decided once. A 401 clears the cached JWT
 * and retries a single time — a token can expire between minting and use, and a silent one-shot
 * re-mint is friendlier than surfacing an auth error the next token would have fixed. This is the
 * same shape the retired ManageEngine client had, deliberately: the two bridges were siblings,
 * not a shared abstraction, and the duplication is the house style on this page.
 *
 * 🔴 HEADWIND CAN SAY NO WITH HTTP 200. Its REST replies are wrapped as `{ status, message, data }`,
 * and a refusal arrives as `status: "ERROR"` with an explanatory `message` inside an otherwise
 * successful response. Reading `response.ok` alone would therefore treat "that device does not exist"
 * as a success carrying an empty result — a whole fleet silently reading as zero tablets is exactly
 * the failure this repo's rules call a fabricated zero. So the envelope is checked here, once, and
 * every caller receives the unwrapped `data` or an error carrying Headwind's own sentence.
 *
 * AN AUTH-SHAPED 200 IS TREATED AS A 401. Some Headwind builds answer an expired token with the same
 * `status: "ERROR"` envelope rather than a 401 status, so a message that names the session or the
 * token re-mints and retries once, exactly as a real 401 would. The retry is capped at one either
 * way, so a genuinely wrong credential fails fast instead of looping.
 */

import {
  getHeadwindToken,
  headwindAccessHeaders,
  headwindAuthConfig,
  HeadwindNotConfiguredError,
  HeadwindRequestError,
  isHeadwindTimeout,
  resetHeadwindTokenCache,
} from "@/lib/devices/headwind/auth";

// The class lives in auth.ts so the sign-in can throw it; every importer keeps reading it from here.
export { HeadwindRequestError, isHeadwindTimeout };

export function headwindApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return headwindAuthConfig(env).baseUrl;
}

type Envelope = { status?: unknown; message?: unknown; data?: unknown };

function isEnvelope(body: unknown): body is Envelope {
  return Boolean(body && typeof body === "object" && !Array.isArray(body) && "status" in (body as object));
}

function messageFromBody(body: unknown, status: number, env: NodeJS.ProcessEnv): string {
  if (isEnvelope(body) && typeof body.message === "string" && body.message.trim()) return body.message.trim();
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    for (const key of ["message", "error", "error_description"] as const) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  if (body === null) {
    // 🔴 A 5xx WITH NO BODY IS THE SERVER FAILING, NOT CLOUDFLARE (9 Nov 2026 audit). The Phoenix
    // add-on answers a fault it cannot handle with an empty 500, and Tomcat's own 5xx pages are HTML;
    // both used to be reported as "what a Cloudflare Access sign-in page looks like", pointing at two
    // variables that may not even be set while the Headwind box itself was down.
    if (status >= 500) {
      return `The Headwind server failed (HTTP ${status}) and gave no reason. This is the server itself — look at its logs before changing any Phoenix setting.`;
    }
    // A non-JSON answer below 500 is not Headwind's — Headwind answers in JSON. With a service token
    // configured the likeliest door is Cloudflare Access; without one, it is the address.
    const accessConfigured = Boolean(env.HEADWIND_MDM_ACCESS_CLIENT_ID?.trim() && env.HEADWIND_MDM_ACCESS_CLIENT_SECRET?.trim());
    return accessConfigured
      ? `The Headwind server answered HTTP ${status} with no readable reply. That is what a Cloudflare ` +
          "Access sign-in page looks like from here — check HEADWIND_MDM_ACCESS_CLIENT_ID and " +
          "HEADWIND_MDM_ACCESS_CLIENT_SECRET before suspecting the server."
      : `The Headwind server answered HTTP ${status} with a reply that is not JSON, which Headwind never ` +
          "sends. Check HEADWIND_MDM_BASE_URL, and if Cloudflare Access is in front of that address, set the " +
          "two HEADWIND_MDM_ACCESS_* values.";
  }
  return `The Headwind server answered HTTP ${status}.`;
}

/** A refusal whose wording says the session is over rather than that the request was wrong. */
function readsAsExpiredSession(message: string): boolean {
  return /\b(token|session|jwt|unauthori[sz]ed|not\s+logged\s+in)\b/i.test(message);
}

/**
 * The sentence for a request that never reached a server at all.
 *
 * 🔴 THE `.railway.internal` BRANCH IS NOT COSMETIC — IT IS THE WHOLE REASON THIS FUNCTION EXISTS.
 * Phoenix and the Headwind box are the same Railway project, so the base URL can be
 * `http://phoenix-headwind.railway.internal:8080` and skip Cloudflare entirely, which also means no
 * Access service token is needed. But Railway's private network is **IPv6-only**, and nothing has yet
 * watched this container resolve an AAAA-only name — so the one thing that setting could get wrong is
 * exactly a name that does not resolve. Without this branch that arrives as `fetch failed` and reads
 * like a broken server; with it, the answer names the network, the reason and the fallback in one
 * sentence, and whoever set the variable can correct it in a minute rather than an evening.
 *
 * The address is included because a typo in it is the other cause, and it is not a secret — the login
 * and password are, and neither is ever in here.
 */
function unreachableMessage(error: unknown, env: NodeJS.ProcessEnv): string {
  const detail = error instanceof Error ? error.message : String(error);
  const base = env.HEADWIND_MDM_BASE_URL?.trim() ?? "";
  if (/\.railway\.internal(:|\/|$)/i.test(base)) {
    return (
      `Nothing answered at ${base} (${detail}). That address is Railway's private network, which is ` +
      "IPv6-only and only reachable from another service in the same project and environment — so it " +
      "works from the Phoenix app on Railway and from nowhere else, including a laptop. If this keeps " +
      "failing there, set HEADWIND_MDM_BASE_URL to https://mdm-console.satopharma.com instead and add " +
      "the two HEADWIND_MDM_ACCESS_* values if Cloudflare Access is on."
    );
  }
  return (
    `Nothing answered at ${base || "the configured Headwind address"} (${detail}). The request never ` +
    "reached a server, so this is the address, DNS or the network — not Headwind refusing anything. " +
    "Check HEADWIND_MDM_BASE_URL first."
  );
}

/**
 * DEADLINES (23 Oct 2026 audit, P5-01). Every call used to wait as long as the socket allowed: a
 * Headwind box (or the Cloudflare tunnel in front of it) that accepted the connection and went silent
 * held the request — a fleet sync, a page, a remote lock — until the platform killed it. Now a call
 * has HEADWIND_REQUEST_TIMEOUT_MS, an upload (an APK going into the app repository) the longer
 * HEADWIND_UPLOAD_TIMEOUT_MS, and the timer covers reading the reply as well as sending.
 */
export const HEADWIND_REQUEST_TIMEOUT_MS = 30_000;
export const HEADWIND_UPLOAD_TIMEOUT_MS = 5 * 60_000;

export function headwindTimeoutFor(init: RequestInit): number {
  return init.body instanceof FormData ? HEADWIND_UPLOAD_TIMEOUT_MS : HEADWIND_REQUEST_TIMEOUT_MS;
}

function withDeadline(init: RequestInit): AbortSignal {
  const deadline = AbortSignal.timeout(headwindTimeoutFor(init));
  return init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
}

/**
 * 🔴 A TIMED-OUT REQUEST IS NOT ONE THAT "NEVER REACHED A SERVER". The request may well have arrived
 * and done its work — locked the tablet, pushed the configuration — with only the reply lost. The
 * transport sentence below says the opposite, and on a remote action it would invite a second press
 * of a button that has already worked. So a timeout says what is actually known.
 */
export function headwindTimeoutMessage(init: RequestInit, env: NodeJS.ProcessEnv): string {
  const base = env.HEADWIND_MDM_BASE_URL?.trim() || "the configured Headwind address";
  const seconds = Math.round(headwindTimeoutFor(init) / 1000);
  const method = String(init.method ?? "GET").toUpperCase();
  const acted = method === "GET" ? "" : " The request may have reached Headwind and taken effect — check the device before repeating it.";
  return `The Headwind server at ${base} did not answer within ${seconds} seconds, so Phoenix stopped waiting.${acted}`;
}

type Attempt = { ok: boolean; status: number; body: unknown; envelopeError: string | null };

async function once(
  path: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
  env: NodeJS.ProcessEnv,
): Promise<Attempt> {
  const token = await getHeadwindToken(fetchImpl, env);
  const response = await fetchImpl(`${headwindApiBase(env)}${path}`, {
    ...init,
    cache: "no-store",
    signal: withDeadline(init),
    headers: {
      authorization: `Bearer ${token}`,
      // Cloudflare Access, when the console is behind the tunnel. Empty when it is not — see
      // `headwindAccessHeaders`. It goes FIRST so `init.headers` can still override anything.
      ...headwindAccessHeaders(env),
      // A multipart upload (an APK going into the app repository) carries no content-type from here —
      // `fetch` writes the real `multipart/form-data; boundary=…` itself, and stamping JSON over it
      // destroys the boundary the far end parses by. A caller may still override via `init.headers`.
      ...(init.body instanceof FormData ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" }),
      ...(init.headers ?? {}),
    },
  });

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  let envelopeError: string | null = null;
  if (isEnvelope(body) && typeof body.status === "string" && body.status.toUpperCase() !== "OK") {
    envelopeError = messageFromBody(body, response.status, env);
  }
  return { body, envelopeError, ok: response.ok, status: response.status };
}

/** The payload a caller wants: the envelope's `data` where there is one, else the body itself. */
function unwrap<T>(body: unknown): T {
  if (isEnvelope(body) && "data" in body) return (body.data ?? ({} as T)) as T;
  return (body ?? ({} as T)) as T;
}

/**
 * Call the Headwind REST API and return its parsed payload, or throw `HeadwindRequestError`.
 *
 * On a 401 — or a 200 whose envelope says the session is over — the token cache is cleared and the
 * call is retried once with a freshly minted token. Any other refusal is an error carrying the
 * status and Headwind's own sentence, so callers can map it the way the register's other routes do.
 */
export async function callHeadwind<T = unknown>(
  path: string,
  init: RequestInit = {},
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  let result: Attempt;
  try {
    result = await once(path, init, fetchImpl, env);
    if (result.status === 401 || (result.envelopeError !== null && readsAsExpiredSession(result.envelopeError))) {
      resetHeadwindTokenCache();
      result = await once(path, init, fetchImpl, env);
    }
  } catch (error) {
    // 🔴 ONLY A REAL TRANSPORT FAILURE MAY BE BLAMED ON THE ADDRESS, AND THIS BRANCH GOT THAT WRONG
    // ON THE FIRST REAL SIGN-IN FAILURE IT EVER SAW (production, 2026-09-26). `once()` mints the token
    // first, so a REFUSED sign-in — the wrong login or password — throws from inside this try (a
    // HeadwindRequestError since 9 Nov 2026; a missing setting is still NotConfigured), and it was being rewrapped as "the request never reached a server, so this
    // is the address, DNS or the network — not Headwind refusing anything. Check HEADWIND_MDM_BASE_URL
    // first." The page therefore printed the correct diagnosis and then flatly contradicted it, and the
    // advice it ended on pointed at the one value that was right. An error that already carries
    // Headwind's own account of what happened is passed through untouched.
    if (error instanceof HeadwindNotConfiguredError || error instanceof HeadwindRequestError) throw error;
    // A deadline is not a transport failure: the request may have arrived (see headwindTimeoutMessage).
    if (isHeadwindTimeout(error)) throw new HeadwindRequestError(504, headwindTimeoutMessage(init, env));
    // A TRANSPORT FAILURE USED TO ARRIVE AS "fetch failed" AND NOTHING ELSE. Every refusal above
    // carries Headwind's own sentence, but a request that never reached a server at all fell through
    // to the generic 500 handler, so the page said "fetch failed" — which names neither the address
    // it tried nor anything to do about it. That is the one failure a wrong base URL produces.
    throw new HeadwindRequestError(502, unreachableMessage(error, env));
  }
  if (!result.ok) {
    throw new HeadwindRequestError(result.status, messageFromBody(result.body, result.status, env));
  }
  if (result.envelopeError !== null) {
    throw new HeadwindRequestError(result.status, result.envelopeError);
  }
  return unwrap<T>(result.body);
}
