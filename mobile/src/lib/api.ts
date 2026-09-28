import { apiBaseUrl, nativeClientId } from "./config";

/**
 * The one place this app talks to Phoenix.
 *
 * Every screen goes through `apiRequest`, so authentication, error shape and session expiry are
 * handled once. A screen that calls `fetch` directly is a bug — it will silently miss the bearer
 * header and read as signed-out.
 *
 * 🔴 EVERY REQUEST HERE SETS `credentials: "omit"`, AND THAT IS LOAD-BEARING, NOT TIDINESS.
 *
 * This app carries its session as a bearer token and must never send a cookie. On Android the
 * WebView's cookie jar IS React Native's own networking jar — the same `CookieManager` behind
 * `ForwardingCookieHandler` — so a `phoenix_session` cookie set for an in-app portal module would
 * otherwise ride every request this file makes. The server's CSRF guard reads a cookie-bearing
 * request as a browser session and refuses it, so every mutation the app makes would come back
 * `csrf_blocked`. That was measured against production on 2026-09-23, and is why `/api/auth/login`
 * actively CLEARS all three cookies for a native caller.
 *
 * `credentials: "omit"` closes it at the source rather than by avoiding a WebView: React Native's
 * own `NetworkingModule` switches that request's OkHttp client to `CookieJar.NO_COOKIES`, so no
 * cookie is attached and none is stored, whatever the shared jar holds. With this in place the
 * portal modules can render INSIDE the app instead of in a system browser tab.
 *
 * Do not remove it, and do not add a `fetch` here without it. `tests/native-web-handoff.test.ts`
 * fails if either call site loses it.
 */

/** Thrown for any non-2xx response. `status` lets a caller distinguish 401/403 from a real fault. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }

  /**
   * True when the server says this session is over — the token expired, was revoked from "Log out
   * everywhere", or the employee's record went inactive. The session layer clears storage and sends
   * the user back to Login when it sees this, rather than leaving a dead token on the device.
   */
  get isSessionExpired(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

/** Raised when the phone has no usable connection. Kept distinct so screens can say so plainly. */
export class NetworkError extends Error {
  constructor(message = "No connection. Check your network and try again.") {
    super(message);
    this.name = "NetworkError";
  }
}

type RequestOptions = {
  /** Bearer token for this call. Omitted only by the login request itself. */
  token?: string | null;
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  /**
   * Abort after this many milliseconds. A rep on a weak connection inside a pharmacy should get a
   * clear failure rather than a spinner that never resolves — React Native's fetch has no default
   * timeout at all, so without this the request can hang until the OS gives up minutes later.
   */
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 20_000;

function errorMessageFrom(payload: unknown, fallback: string): { message: string; code: string | null } {
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const message = typeof record.message === "string" && record.message.trim().length > 0
      ? record.message
      : fallback;
    const code = typeof record.error === "string" ? record.error : null;
    return { code, message };
  }
  return { code: null, message: fallback };
}

/**
 * Perform an authenticated Phoenix API call and return the parsed body.
 *
 * `path` is server-relative and must start with "/" — e.g. "/api/employee-portals/home".
 */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, method = "GET", timeoutMs = DEFAULT_TIMEOUT_MS, token } = options;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      // 🔴 THIS APP NEVER SENDS A COOKIE, AND MUST NOT — see the header above.
      credentials: "omit",
      headers: {
        accept: "application/json",
        "x-phoenix-client": nativeClientId,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      method,
      signal: controller.signal,
    });
  } catch (error) {
    // fetch rejects for DNS failure, no route to host, TLS problems and our own abort alike. None
    // of them is an API error, and all of them mean the same thing to the person holding the phone.
    if (error instanceof Error && error.name === "AbortError") {
      throw new NetworkError("The server took too long to answer. Try again.");
    }
    throw new NetworkError();
  } finally {
    clearTimeout(timeout);
  }

  const raw = await response.text();
  let parsed: unknown = null;
  if (raw.length > 0) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A non-JSON body from a JSON endpoint means something upstream answered instead of the app —
      // a proxy error page, or a captive portal. Report the status, never the HTML.
      if (!response.ok) {
        throw new ApiError(`Server error (${response.status}).`, response.status);
      }
      throw new ApiError("The server sent an unreadable response.", response.status);
    }
  }

  if (!response.ok) {
    const { code, message } = errorMessageFrom(parsed, `Request failed (${response.status}).`);
    throw new ApiError(message, response.status, code);
  }

  return parsed as T;
}

/**
 * Unwrap the `{ data, success }` envelope this repo's API routes return.
 *
 * Kept separate from `apiRequest` because not every endpoint uses the envelope — the login route
 * returns its fields at the top level — and silently reaching for `.data` on one that does not is
 * how a screen ends up rendering `undefined` with no error anywhere.
 */
export async function apiGetData<T>(path: string, token: string | null): Promise<T> {
  const payload = await apiRequest<{ data: T; success: boolean }>(path, { token });
  return payload.data;
}

/**
 * A file part as React Native's `FormData` accepts it.
 *
 * React Native implements `FormData.append` with an extra overload the DOM does not have: given
 * `{ uri, name, type }` it streams the file straight off disk, so a 3 MB photo never has to be read
 * into JavaScript memory as a Blob first. TypeScript's lib.dom `FormData` knows nothing about that
 * overload, which is why the cast below exists — it is a gap in the type declarations, not a trick.
 */
type NativeFilePart = { name: string; type: string; uri: string };

/**
 * Upload a file to a Phoenix route that reads `multipart/form-data`.
 *
 * 🔴 DO NOT SET `content-type` HERE. `fetch` generates the multipart boundary itself and writes the
 * header to match; setting it by hand produces a header whose boundary does not match the body, and
 * the server then parses zero parts and answers "An image file is required." — a 400 that reads like
 * a missing file when the file was there all along.
 *
 * The timeout is longer than the default: this is bytes over a field connection, not a JSON read,
 * and 20 seconds is short enough to fail a rep mid-upload on ordinary 3G.
 */
export async function apiUpload<T>(
  path: string,
  options: { field?: string; file: NativeFilePart; timeoutMs?: number; token: string | null },
): Promise<T> {
  const { field = "file", file, timeoutMs = 60_000, token } = options;

  const form = new FormData();
  form.append(field, file as unknown as Blob);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      body: form,
      // 🔴 Same as `apiRequest` — see the header. An upload is a mutation, so this is the call the
      // CSRF guard would refuse first if a cookie ever rode along.
      credentials: "omit",
      headers: {
        accept: "application/json",
        "x-phoenix-client": nativeClientId,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      method: "POST",
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new NetworkError("The upload took too long. Try again where the signal is better.");
    }
    throw new NetworkError("No connection. The photo was not sent — try again.");
  } finally {
    clearTimeout(timeout);
  }

  const raw = await response.text();
  let parsed: unknown = null;
  if (raw.length > 0) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      if (!response.ok) throw new ApiError(`Server error (${response.status}).`, response.status);
      throw new ApiError("The server sent an unreadable response.", response.status);
    }
  }

  if (!response.ok) {
    const { code, message } = errorMessageFrom(parsed, `Upload failed (${response.status}).`);
    throw new ApiError(message, response.status, code);
  }

  return parsed as T;
}
