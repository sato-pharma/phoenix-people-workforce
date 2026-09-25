/**
 * The one HTTP path to the company's Headwind MDM server.
 *
 * Every device read and every remote action goes through `callHeadwind`, so the bearer header, the
 * base address, the JSON handling and the error shape are decided once. A 401 clears the cached JWT
 * and retries a single time — a token can expire between minting and use, and a silent one-shot
 * re-mint is friendlier than surfacing an auth error the next token would have fixed. This is the
 * same shape `manageengine/client.ts` has, deliberately: the two bridges are siblings, not a shared
 * abstraction, and the duplication is the house style on this page.
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
  resetHeadwindTokenCache,
} from "@/lib/devices/headwind/auth";

export class HeadwindRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HeadwindRequestError";
    this.status = status;
  }
}

export function headwindApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return headwindAuthConfig(env).baseUrl;
}

type Envelope = { status?: unknown; message?: unknown; data?: unknown };

function isEnvelope(body: unknown): body is Envelope {
  return Boolean(body && typeof body === "object" && !Array.isArray(body) && "status" in (body as object));
}

function messageFromBody(body: unknown, status: number): string {
  if (isEnvelope(body) && typeof body.message === "string" && body.message.trim()) return body.message.trim();
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    for (const key of ["message", "error", "error_description"] as const) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  // 🔴 NO READABLE BODY AT ALL MEANS THE ANSWER WAS NOT HEADWIND'S. With the console behind a
  // Cloudflare Tunnel, an Access sign-in PAGE comes back in place of an answer — so the honest
  // sentence names that door rather than leaving a person to suspect the server.
  if (body === null) {
    return (
      `The Headwind server answered HTTP ${status} with no readable reply. That is what a Cloudflare ` +
      "Access sign-in page looks like from here — check HEADWIND_MDM_ACCESS_CLIENT_ID and " +
      "HEADWIND_MDM_ACCESS_CLIENT_SECRET before suspecting the server."
    );
  }
  return `The Headwind server answered HTTP ${status}.`;
}

/** A refusal whose wording says the session is over rather than that the request was wrong. */
function readsAsExpiredSession(message: string): boolean {
  return /\b(token|session|jwt|unauthori[sz]ed|not\s+logged\s+in)\b/i.test(message);
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
    envelopeError = messageFromBody(body, response.status);
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
  let result = await once(path, init, fetchImpl, env);
  if (result.status === 401 || (result.envelopeError !== null && readsAsExpiredSession(result.envelopeError))) {
    resetHeadwindTokenCache();
    result = await once(path, init, fetchImpl, env);
  }
  if (!result.ok) {
    throw new HeadwindRequestError(result.status, messageFromBody(result.body, result.status));
  }
  if (result.envelopeError !== null) {
    throw new HeadwindRequestError(result.status, result.envelopeError);
  }
  return unwrap<T>(result.body);
}
