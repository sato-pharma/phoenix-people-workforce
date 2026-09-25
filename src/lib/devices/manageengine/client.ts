/**
 * The one HTTP path to the ManageEngine MDM Plus Cloud API.
 *
 * Every device read and every remote command goes through `callManageEngine`, so the auth header,
 * the base host, the JSON handling and the error shape are decided once. A 401 clears the cached
 * access token and retries a single time — an access token can expire between minting and use, and a
 * silent one-shot refresh is friendlier than surfacing an auth error the next token would have fixed.
 *
 * THE BASE HOST IS THE DATA-CENTRE HOST, from env, defaulting to the US `mdm.manageengine.com`. It
 * must match the region the tenant lives in (.eu, .in, …); a mismatch reads as an auth failure.
 */

import { getManageEngineAccessToken, resetManageEngineTokenCache } from "@/lib/devices/manageengine/auth";

const DEFAULT_API_BASE = "https://mdm.manageengine.com";

export class ManageEngineRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ManageEngineRequestError";
    this.status = status;
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function manageEngineApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return trimTrailingSlash(env.MANAGEENGINE_MDM_API_BASE?.trim() || DEFAULT_API_BASE);
}

function messageFromBody(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    // ManageEngine wraps errors as { error_description } or { error: { message } } or a bare message.
    const record = body as Record<string, unknown>;
    const description = record.error_description ?? record.message;
    if (typeof description === "string" && description) return description;
    const nested = record.error;
    if (nested && typeof nested === "object" && typeof (nested as Record<string, unknown>).message === "string") {
      return (nested as Record<string, string>).message;
    }
  }
  return `ManageEngine answered HTTP ${status}.`;
}

async function once<T>(path: string, init: RequestInit, fetchImpl: typeof fetch, env: NodeJS.ProcessEnv): Promise<{
  ok: boolean;
  status: number;
  body: T | null;
}> {
  const token = await getManageEngineAccessToken(fetchImpl, env);
  const response = await fetchImpl(`${manageEngineApiBase(env)}${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      authorization: `Zoho-oauthtoken ${token}`,
      // 🔴 A MULTIPART FILE UPLOAD CARRIES NEITHER `accept: application/json` NOR a `content-type`
      // FROM HERE, and both omissions are load-bearing. `fetch` writes the real
      // `multipart/form-data; boundary=…` itself, and stamping `application/json` over it destroys the
      // boundary the far end parses by. Less obviously, `/emsapi/files` REFUSES an upload that also
      // asks for `accept: application/json` — it answers `406 Not Acceptable`, reading the whole body
      // first — yet returns the file JSON perfectly well when Accept is absent. Measured against the
      // live Cloud tenant on 2026-09-25: same 57-byte part, `accept: application/json` → 406, no
      // Accept header → 200 with the `fileID`. So a JSON body gets both headers, a FormData body gets
      // neither, and a caller may still override via `init.headers`.
      ...(init.body instanceof FormData ? {} : { accept: "application/json", "content-type": "application/json" }),
      ...(init.headers ?? {}),
    },
  });
  let body: T | null = null;
  try {
    body = (await response.json()) as T;
  } catch {
    body = null;
  }
  return { body, ok: response.ok, status: response.status };
}

/**
 * Call the MDM API and return its parsed JSON, or throw `ManageEngineRequestError`.
 *
 * On a 401 the token cache is cleared and the call is retried once with a freshly minted token; any
 * other non-2xx is an error carrying the status, so callers can map it (403 → forbidden, 404 → gone,
 * and so on) the way the register's other routes do.
 */
export async function callManageEngine<T = unknown>(
  path: string,
  init: RequestInit = {},
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  let result = await once<T>(path, init, fetchImpl, env);
  if (result.status === 401) {
    resetManageEngineTokenCache();
    result = await once<T>(path, init, fetchImpl, env);
  }
  if (!result.ok) {
    throw new ManageEngineRequestError(result.status, messageFromBody(result.body, result.status));
  }
  return (result.body ?? ({} as T)) as T;
}
