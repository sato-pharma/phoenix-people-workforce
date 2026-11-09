/**
 * Signing in to the company's own Headwind MDM server.
 *
 * WHY THIS EXISTS. ManageEngine's free edition caps the fleet at 25 tablets and stops remote screen
 * view and control when the trial ends, and the owner expects to reach about a hundred tablets
 * (2026-09-25). Headwind MDM Community is open source, self-hosted and has NO managed-device limit,
 * so Phoenix drives the tablets through the company's own server instead. This module is the sign-in
 * half of that bridge; `client.ts` is the one HTTP path built on it.
 *
 * THE CREDENTIAL IS AN ADMIN LOGIN ON THE COMPANY'S OWN SERVER, set as server-only env. There is no
 * vendor, no OAuth dance and no third party holding a token: the server is ours.
 * 🔴 NONE OF THESE VALUES ARE IN GIT, and none of them may ever be logged — a Headwind admin login is
 * a password that factory-resets tablets.
 *
 * 🔴 THE PASSWORD IS SENT AS AN MD5 HASH, NOT AS ITSELF, AND THAT IS HEADWIND'S WIRE FORMAT, NOT A
 * SECURITY CHOICE OF OURS. `POST /rest/public/jwt/login` takes `{ login, password }` where `password`
 * is the UPPER-CASE hex MD5 of the real one (`headwindPasswordHash` below; the console's own login
 * upper-cases it); sending the plain password fails to sign in. The real
 * password never leaves this module, and the transport is HTTPS either way. Do not "upgrade" this to
 * SHA-256 — the server would simply refuse every sign-in.
 *
 * THE TOKEN IS CACHED IN MEMORY, never persisted, and shared between concurrent callers the way the
 * ManageEngine bridge shares its access token: the Rep Tablets page loads several cards at once and a
 * cold cache would otherwise sign in several times in the same instant. Headwind does not publish the
 * JWT's lifetime, so the cache is deliberately short and `client.ts` re-mints once on a 401 — the
 * cache is an optimisation, never a correctness assumption.
 */

import { createHash } from "node:crypto";

const LOGIN_PATH = "/rest/public/jwt/login";

/**
 * How long a minted JWT is trusted before it is re-minted.
 *
 * 🔴 THIS IS OURS, NOT HEADWIND'S. Headwind does not document the lifetime of the token
 * `/rest/public/jwt/login` returns, so nothing here may claim to know it. Thirty minutes is short
 * enough that an expiry is rare and cheap when it happens (signing in again is one request to our own
 * server), and `callHeadwind` clears the cache and retries once on a 401 regardless — so a token that
 * expires sooner than this costs one retry, never a failed action.
 */
const TOKEN_LIFETIME_MS = 30 * 60_000;

/**
 * A setting Phoenix needs is not there: a missing credential, or half a Cloudflare Access pair.
 *
 * 🔴 ONLY THAT. A server that answered — refused the credential, failed with a 5xx, or sent a page
 * that is not Headwind's — is a `HeadwindRequestError` (9 Nov 2026 audit, F17). This class used to
 * carry all of those, so a Headwind box answering 503 put the page into "connect the bridge" and the
 * hourly fleet watch reported "the Headwind settings are not set" about settings that were set.
 */
export class HeadwindNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HeadwindNotConfiguredError";
  }
}

/**
 * The Headwind server answered, and the answer was a refusal or a failure — or nothing answered.
 *
 * Defined here rather than in `client.ts`, which re-exports it, because the sign-in has to throw it
 * too and `client.ts` already imports this module (a class cannot cross a circular import safely).
 */
export class HeadwindRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HeadwindRequestError";
    this.status = status;
  }
}

/** A fetch that ran out of time — DOMException "TimeoutError" from AbortSignal.timeout, however it is wrapped. */
export function isHeadwindTimeout(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 4; depth += 1) {
    if (typeof current === "object" && (current as { name?: unknown }).name === "TimeoutError") return true;
    current = typeof current === "object" ? (current as { cause?: unknown }).cause : null;
  }
  return false;
}

export type HeadwindAuthConfig = {
  /** The company's Headwind server, e.g. https://mdm.satopharma.com — no trailing slash. */
  baseUrl: string;
  login: string;
  password: string;
};

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * The Headwind credential from env, or a clear error naming exactly what is missing.
 *
 * Nothing here has a safe default: a guessed server address would send an admin password to whoever
 * owns that name.
 */
export function headwindAuthConfig(env: NodeJS.ProcessEnv = process.env): HeadwindAuthConfig {
  const baseUrl = trimTrailingSlash(env.HEADWIND_MDM_BASE_URL?.trim() ?? "");
  const login = env.HEADWIND_MDM_LOGIN?.trim();
  const password = env.HEADWIND_MDM_PASSWORD?.trim();

  const missing = [
    baseUrl ? null : "HEADWIND_MDM_BASE_URL",
    login ? null : "HEADWIND_MDM_LOGIN",
    password ? null : "HEADWIND_MDM_PASSWORD",
  ].filter((entry): entry is string => entry !== null);
  if (missing.length > 0) {
    throw new HeadwindNotConfiguredError(
      `The Headwind bridge is not connected yet: set ${missing.join(", ")} (from the company's own Headwind server). ` +
        "Until then the Phoenix console cannot reach the tablets on it.",
    );
  }

  return { baseUrl, login: login!, password: password! };
}

/** True when all three Headwind settings are present — the bridge can reach the company's server. */
export function isHeadwindConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.HEADWIND_MDM_BASE_URL?.trim() && env.HEADWIND_MDM_LOGIN?.trim() && env.HEADWIND_MDM_PASSWORD?.trim(),
  );
}

/**
 * The Cloudflare Access service-token headers, when the console is behind a Cloudflare Tunnel.
 *
 * WHY THIS EXISTS (owner's decision, 2026-09-25: "use cloudflare tunnel for the mdm console"). The
 * console sits behind Cloudflare Access — a person signs in to Cloudflare before the login page is
 * even reachable. 🔴 BUT PHOENIX IS NOT A PERSON AND CANNOT SIGN IN. Without these two headers every
 * call from Phoenix would be answered by Cloudflare's own sign-in page instead of by Headwind, and
 * the whole bridge would go dark the moment the tunnel was switched on. A service token is
 * Cloudflare's answer for exactly that: a machine credential Access accepts in place of a human
 * session.
 *
 * 🔴 THIS COMMENT USED TO SAY "Headwind Community has no two-factor sign-in", AND THAT IS FALSE —
 * corrected 2026-10-22 against the upstream source: `settings.twoFactor` is a real column and the
 * server has the TOTP endpoints. 🔴 BUT ITS CONSOLE UI IS HARD-DISABLED UPSTREAM (`ng-if="false"` on
 * the whole two-factor form), so Headwind 2FA is unavailable in this build and Access is the console's
 * ONLY second factor — not a stand-in for a missing feature, and not mere hardening
 * (`docs/devices/headwind-rustdesk.md` §4.7). The console otherwise sits on the public internet behind
 * one password that factory-resets tablets.
 *
 * 🔴 AND 2FA WOULD NOT TOUCH THIS BRIDGE EITHER WAY — never warn that it will dark the fleet, and
 * never ask for a second account to dodge it. Were it reachable it would be ONE server-wide switch
 * (`settings.twoFactor`, one row per `customerId`; no per-account toggle) read only by the CONSOLE's
 * `AuthResource`. The endpoint this module calls is a different class: `POST /rest/public/jwt/login`
 * is `JWTAuthResource.login`, which injects no `SettingsDAO` at all — it matches the MD5 password,
 * calls `tokenProvider.createToken` and returns a bare `{ id_token }`.
 *
 * 🔴 AND THIS IS WHY THERE IS NO `/rest/*` BYPASS RULE IN THE RUNBOOK. Putting Access on the console
 * while letting the REST API through unauthenticated would protect nothing that matters: the API is
 * what lists, commands and factory-resets tablets, and the console is only a browser talking to it.
 * A bypass would lock the front door and leave the back one open.
 *
 * BOTH OR NEITHER. One alone cannot authenticate, and Access would answer an HTML sign-in page that
 * is not JSON — so a half-set pair is refused here, by name, rather than surfacing later as an
 * unreadable reply from a server that is in fact perfectly healthy.
 */
export function headwindAccessHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const id = env.HEADWIND_MDM_ACCESS_CLIENT_ID?.trim();
  const secret = env.HEADWIND_MDM_ACCESS_CLIENT_SECRET?.trim();
  if (!id && !secret) return {};
  if (!id || !secret) {
    throw new HeadwindNotConfiguredError(
      "The Cloudflare Access service token is only half set: " +
        `${id ? "HEADWIND_MDM_ACCESS_CLIENT_SECRET" : "HEADWIND_MDM_ACCESS_CLIENT_ID"} is missing. ` +
        "Set both or neither — with one alone, Cloudflare answers every Phoenix request with its own " +
        "sign-in page and the Headwind server never sees it.",
    );
  }
  return { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret };
}

/**
 * Headwind's wire form for a password: **UPPER-CASE** hex MD5. See the header — this is not a choice.
 *
 * 🔴 IT WAS LOWER-CASE UNTIL 2026-09-26, AND THAT WOULD HAVE FAILED EVERY SIGN-IN AGAINST A PERFECTLY
 * CORRECT PASSWORD. Read from the console the live server serves — the authoritative client, not the
 * documentation: `login.controller.js` sends `md5($scope.login.password).toUpperCase()`, and
 * `users.controller.js` stores a new password the same way (`newPassword`/`confirmModal`, both
 * upper-cased). So the hash sitting in the server's own column is upper-case hex, and a lower-case one
 * matches it only if the comparison happens to be case-insensitive — which nothing here has proven and
 * nothing should depend on. Matching the official client removes the question entirely.
 *
 * That mattered more than a normal near-miss: the failure it produces is `errorCode=1`, "user found,
 * password wrong", which reads as a typo in the credential and sends whoever hit it back to the
 * console to re-type a password that was right all along.
 */
export function headwindPasswordHash(password: string): string {
  return createHash("md5").update(password, "utf8").digest("hex").toUpperCase();
}

type CachedToken = { token: string; expiresAt: number };
let cached: CachedToken | null = null;
/** A sign-in already in flight, shared by every caller until it settles, so a cold page signs in once. */
let pending: Promise<string> | null = null;

type LoginResponse = {
  status?: unknown;
  message?: unknown;
  data?: unknown;
  token?: unknown;
  authToken?: unknown;
  id_token?: unknown;
  idToken?: unknown;
};

/**
 * What the server is DEMANDING when it answers a correct credential with no token, or null.
 *
 * 🔴 A 200 WITH NO TOKEN IS NOT ALWAYS A REFUSAL, AND CALLING IT ONE COST AN EVENING. Headwind's
 * login answers `status: "OK"` with `data.passwordReset` and a `passwordResetToken` when the account
 * must change its password before it can be used — which is what a freshly created console user is
 * set to — and `data.twoFactor` when 2FA is on. Its own console reads both and moves the person to the
 * right screen (`login.controller.js`). Phoenix read neither, found no token, and reported "the server
 * refused the Phoenix sign-in — check HEADWIND_MDM_LOGIN and HEADWIND_MDM_PASSWORD", against a login
 * and a password that were both exactly right. Measured on production 2026-09-26: the server's own
 * audit log recorded that same sign-in as `errorCode=0`, a SUCCESS, while the page called it a refusal.
 *
 * 🔴 THE `twoFactor` BRANCH CANNOT FIRE ON THE ENDPOINT THIS MODULE CALLS, AND IS KEPT ONLY AS A
 * GUARD — read it as a measurement and you will reach the wrong conclusion. Both branches below read
 * the enveloped `{ status, data }` shape the CONSOLE's `AuthResource` returns; `/rest/public/jwt/login`
 * is `JWTAuthResource`, which answers a bare `{ id_token }` and never consults `settings.twoFactor`.
 * So a `twoFactor` demand here is NOT evidence that 2FA breaks the bridge — it does not
 * (`docs/devices/headwind-rustdesk.md` §4.7) — and this branch's "use an account without it for the
 * bridge" is a leftover from that misreading: 2FA is server-wide, so there is no such account to pick.
 */
function demandFromLogin(payload: LoginResponse): string | null {
  const data = payload.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  if (record.passwordReset) {
    return (
      "the credential is CORRECT and the server is asking for a password change before this account " +
      "can be used — which is how a newly created console user arrives. Sign in to the console once as " +
      "this login, set a new password when it asks, and put THAT password in HEADWIND_MDM_PASSWORD."
    );
  }
  if (record.twoFactor) {
    return (
      "the credential is CORRECT and this account has two-factor authentication on, which Phoenix " +
      "cannot complete — use an account without it for the bridge."
    );
  }
  return null;
}

/**
 * The token out of a Headwind login response, whatever shape this server's version answers in.
 *
 * Headwind wraps REST replies as `{ status, message, data }`, and the JWT has been seen both at
 * `data.authToken` and, on other builds, as a bare `data` string or a top-level `token`. Reading a
 * short candidate list rather than pinning one spelling means a server upgrade cannot silently break
 * sign-in with a token that is present but under a different name.
 *
 * 🔴 AND ON THIS SERVER IT IS `id_token`, AT THE TOP LEVEL, WITH NO ENVELOPE AT ALL — which is the
 * single fault that cost the owner an entire night. Measured against production on 2026-09-26 with the
 * service's own injected variables: `POST /rest/public/jwt/login` answers **HTTP 200,
 * application/json, `{ id_token: "<195 chars>" }`** — no `status`, no `message`, no `data`. The
 * candidate list above missed it, so a sign-in that SUCCEEDED was reported as "the Headwind server
 * refused the Phoenix sign-in — check HEADWIND_MDM_LOGIN and HEADWIND_MDM_PASSWORD", and the account,
 * the password, the hostname and the hash form were each searched in turn for a fault none of them
 * had. The server's own audit log recorded those same attempts as `errorCode=0`.
 *
 * With `id_token` read, the token works: `GET /rest/private/users/roles` answers HTTP 200 and lists
 * `Admin · User · Observer`. **Never narrow this list to one spelling.**
 */
function tokenFromLogin(payload: LoginResponse): string | null {
  const candidates: unknown[] = [payload.id_token, payload.idToken, payload.token, payload.authToken];
  const data = payload.data;
  if (typeof data === "string") candidates.push(data);
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    candidates.push(record.id_token, record.idToken, record.authToken, record.token, record.jwt, record.accessToken, record.access_token);
  }
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

/**
 * A valid Headwind JWT, minted from the admin login and cached until it nears expiry.
 *
 * Concurrent callers share one in-flight sign-in. A missing setting is `HeadwindNotConfiguredError`;
 * everything the server answered — a refused credential, a 5xx, a page that is not Headwind's — is a
 * `HeadwindRequestError` naming what came back and what to check.
 */
export const HEADWIND_LOGIN_TIMEOUT_MS = 30_000;

export async function getHeadwindToken(
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  if (pending) return pending;
  pending = mintHeadwindToken(fetchImpl, env).finally(() => {
    pending = null;
  });
  return pending;
}

/**
 * 🔴 A SIGN-IN THAT RAN OUT OF TIME SENT NOTHING ELSE (9 Nov 2026 audit). The sign-in is minted inside
 * `callHeadwind`, so its timeout used to reach the caller's deadline sentence — and on a lock or a wipe
 * that sentence says "the request may have reached Headwind and taken effect — check the device
 * before repeating it", about an action that was never sent. So the sign-in says what is known.
 */
function signInTimeoutError(config: HeadwindAuthConfig): HeadwindRequestError {
  return new HeadwindRequestError(
    504,
    `The Headwind server at ${config.baseUrl} did not answer Phoenix's sign-in within ` +
      `${Math.round(HEADWIND_LOGIN_TIMEOUT_MS / 1000)} seconds, so Phoenix stopped waiting. Nothing else was ` +
      "sent: no action reached the server or any tablet, and it is safe to try again.",
  );
}

async function mintHeadwindToken(fetchImpl: typeof fetch, env: NodeJS.ProcessEnv): Promise<string> {
  const config = headwindAuthConfig(env);

  let response: Response;
  let payload: LoginResponse = {};
  let answeredJson = true;
  try {
    response = await fetchImpl(`${config.baseUrl}${LOGIN_PATH}`, {
      body: JSON.stringify({ login: config.login, password: headwindPasswordHash(config.password) }),
      cache: "no-store",
      // The Access headers go on the sign-in too — it is the FIRST request Cloudflare sees, so a
      // tunnel would otherwise turn every other call into a failure that blames the credential.
      headers: { accept: "application/json", "content-type": "application/json", ...headwindAccessHeaders(env) },
      method: "POST",
      // The same 30-second deadline as every other call (client.ts HEADWIND_REQUEST_TIMEOUT_MS) — a
      // sign-in that hangs would otherwise hold every call queued behind it on `pending`.
      signal: AbortSignal.timeout(HEADWIND_LOGIN_TIMEOUT_MS),
    });
    try {
      payload = (await response.json()) as LoginResponse;
    } catch (error) {
      // The deadline covers reading the reply too; a reply cut off by it is a timeout, not HTML.
      if (isHeadwindTimeout(error)) throw error;
      payload = {};
      answeredJson = false;
    }
  } catch (error) {
    if (isHeadwindTimeout(error)) throw signInTimeoutError(config);
    // A transport failure keeps its own sentence in `callHeadwind` ("never reached a server").
    throw error;
  }

  // 🔴 A 5xx AT SIGN-IN IS THE SERVER FAILING, NOT A SETTING THAT IS MISSING (F17). It used to come
  // out as HeadwindNotConfiguredError, which the page draws as "connect the bridge" and the fleet
  // watch reads as "the Headwind settings are not set". The credential was never looked at.
  if (response.status >= 500) {
    const said = typeof payload.message === "string" && payload.message ? ` It said: ${payload.message}.` : "";
    throw new HeadwindRequestError(
      502,
      `The Headwind server at ${config.baseUrl} failed while signing Phoenix in (HTTP ${response.status}).${said} ` +
        "This is the server, not the login or the password — nothing else was sent.",
    );
  }

  const token = response.ok ? tokenFromLogin(payload) : null;
  if (!token) {
    // 🔴 A 2xx THAT IS NOT JSON IS NOT HEADWIND REFUSING ANYTHING. Headwind refuses a sign-in with a
    // JSON envelope or with Tomcat's HTML 401 — never with a 200 page. A 200 page is a door in front
    // of it (a Cloudflare Access sign-in page answers 200 text/html) or an address that is not the
    // Headwind server at all, and naming the password there sends the reader to the one thing that
    // is right.
    if (response.ok && !answeredJson) {
      const accessConfigured = Object.keys(headwindAccessHeaders(env)).length > 0;
      throw new HeadwindRequestError(
        502,
        `The sign-in at ${config.baseUrl} was answered HTTP ${response.status} with a page that is not ` +
          "Headwind's — Headwind itself always answers a sign-in in JSON. " +
          (accessConfigured
            ? "A Cloudflare Access service token is set, so check HEADWIND_MDM_ACCESS_CLIENT_ID and HEADWIND_MDM_ACCESS_CLIENT_SECRET, then HEADWIND_MDM_BASE_URL."
            : "That is what a Cloudflare Access sign-in page, or an address that is not the Headwind server, looks like: check HEADWIND_MDM_BASE_URL, and set the two HEADWIND_MDM_ACCESS_* values if Access is in front of it."),
      );
    }
    // Before blaming the credential: the server may have ACCEPTED it and be demanding something else.
    // 403, not 401: the credential is right and the account is held back from use.
    const demand = response.ok ? demandFromLogin(payload) : null;
    if (demand) throw new HeadwindRequestError(403, `The Headwind server accepted the sign-in, but ${demand}`);
    const said = typeof payload.message === "string" && payload.message ? ` (${payload.message})` : "";
    // 🔴 A NON-JSON REPLY IS NOT EVIDENCE OF CLOUDFLARE. This branch used to say it was, and it was
    // measured wrong on 2026-09-26: `POST /rest/public/jwt/login` on the live server, with a login
    // that does not exist and no Cloudflare anywhere in the path, answers a TOMCAT HTML 401 error
    // page. So an ordinary wrong password produces exactly the reply this code called "what an Access
    // sign-in page looks like", and it sent the reader to two variables that are not even set.
    // What DOES separate the two doors is whether a service token is configured at all: with none,
    // nothing but Headwind can be answering, so the credential is the only thing left to check.
    const accessConfigured = Object.keys(headwindAccessHeaders(env)).length > 0;
    const credentialAdvice = ` Check HEADWIND_MDM_LOGIN and HEADWIND_MDM_PASSWORD against the admin account on ${config.baseUrl}.`;
    const wrongDoor = answeredJson
      ? credentialAdvice
      : accessConfigured
        ? " The reply was not JSON at all, and with a Cloudflare Access service token set here that is" +
          " what its sign-in page looks like from this side: check HEADWIND_MDM_ACCESS_CLIENT_ID and" +
          " HEADWIND_MDM_ACCESS_CLIENT_SECRET first, and only then the Headwind admin login."
        : " The reply was not JSON at all, which is ALSO what Headwind's own Tomcat sends when it" +
          " refuses a sign-in — measured on this server, a login that does not exist comes back as an" +
          " HTML 401 page. No Cloudflare Access service token is set, so nothing else is in the path." +
          credentialAdvice;
    // A refusal is the server ANSWERING — a HeadwindRequestError, never "not configured" (F17). A
    // refusal inside a 200 envelope is carried as 401, which is what it means.
    throw new HeadwindRequestError(
      response.ok ? 401 : response.status,
      `The Headwind server refused the Phoenix sign-in${said}.${wrongDoor} (HTTP ${response.status}.)`,
    );
  }

  cached = { expiresAt: Date.now() + TOKEN_LIFETIME_MS, token };
  return token;
}

/** Drop the cached token — for tests, and after a 401 so the next call signs in again. */
export function resetHeadwindTokenCache(): void {
  cached = null;
  pending = null;
}
