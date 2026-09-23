import { useCallback, useEffect, useState } from "react";

import { ApiError, NetworkError, apiRequest } from "@/lib/api";
import { useSession } from "@/lib/session";

/**
 * Phoenix CRM — how the app talks to /api/phoenix-crm.
 *
 * The web client (src/components/phoenix-crm/api.ts) reads `{ <key>, success: true }` from every route
 * and shows a refusal's `message` as it is, branching on `error.code` only where a refusal asks a
 * question back (a customer with the same name, a visit that moved on). This is the same contract, over
 * the app's own `apiRequest`, so authentication, timeouts and session expiry stay in one place:
 *
 *   - `apiRequest` attaches the bearer token and the `x-phoenix-client` header (which is what exempts
 *     these writes from the CSRF check on the server), and throws `ApiError`/`NetworkError`;
 *   - `ApiError.code` is the route's `error` field, and `ApiError.isSessionExpired` is a 401/403;
 *   - a screen catches `ApiError` and reads `.code`; a read hook signs out on an expired session.
 *
 * There is no offline cache here, unlike `usePhoenixQuery`: a rep validates a customer or enters a
 * visit only where there is a connection to take the photo, so a stale list read from the keystore
 * would only offer an action that cannot complete.
 */

/** Bytes over a field connection, as the app allows for a photo upload — not a plain JSON read. */
const UPLOAD_TIMEOUT_MS = 60_000;

type Envelope = Record<string, unknown>;

/** A GET path with its query. Empty, null and false values are left out, exactly as the web builds it. */
export function crmUrl(path: string, params: Record<string, string | number | boolean | null | undefined> = {}): string {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "" || value === false) continue;
    search.set(name, value === true ? "true" : String(value));
  }
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

export async function crmGet<T>(path: string, key: string, token: string | null): Promise<T> {
  const envelope = await apiRequest<Envelope>(path, { token });
  return envelope[key] as T;
}

export async function crmPost<T>(path: string, key: string, payload: unknown, token: string | null, options: { timeoutMs?: number } = {}): Promise<T> {
  const envelope = await apiRequest<Envelope>(path, { body: payload ?? {}, method: "POST", timeoutMs: options.timeoutMs, token });
  return envelope[key] as T;
}

/** A POST that carries a photo, given the longer upload timeout. */
export function crmUpload<T>(path: string, key: string, payload: unknown, token: string | null): Promise<T> {
  return crmPost<T>(path, key, payload, token, { timeoutMs: UPLOAD_TIMEOUT_MS });
}

/** The refusal's short code, when the server gave one, so a screen can branch on a question it asks back. */
export function crmErrorCode(error: unknown): string | null {
  return error instanceof ApiError ? error.code : null;
}

/** A sentence for the person who pressed the button, whatever went wrong. */
export function crmErrorMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof NetworkError) return error.message;
  if (error instanceof Error && error.message.trim()) return error.message;
  return "Something went wrong. Try again.";
}

/**
 * A fresh v4 UUID for a save that may be sent twice — a visit retried after a dropped connection keeps
 * the same id, so the server answers with the saved visit instead of writing a second one.
 *
 * Uses the platform's own randomness where the runtime provides it (`crypto.randomUUID`, then
 * `getRandomValues`); the last resort is `Math.random`, whose only job here is to make an idempotency
 * key that will not collide with this device's next visit, not to be a secret.
 */
export function newClientId(): string {
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();

  const bytes = new Uint8Array(16);
  if (cryptoObj?.getRandomValues) {
    cryptoObj.getRandomValues(bytes);
  } else {
    for (let index = 0; index < 16; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type CrmResource<T> = {
  data: T | null;
  error: string | null;
  /** True on the first load only — a reload keeps the previous data on screen. */
  loading: boolean;
  /** True while a pull-to-refresh or a reload is in flight. */
  refreshing: boolean;
  reload: () => void;
  /** Put a fresh view a save answered with straight on screen, without another read. */
  replace: (next: T) => void;
};

/**
 * Read one Phoenix CRM view. `path` null means there is nothing to read yet (the seat is not chosen).
 * Changing the path drops the old view (another territory's list must never sit under this one's name);
 * a reload of the same path keeps the last answer on screen until the new one arrives. A 401/403 signs
 * the app out, the same as every other read.
 */
export function useCrm<T>(path: string | null, key: string): CrmResource<T> {
  const { handleExpiredSession, token } = useSession();
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean; refreshing: boolean; path: string | null }>({
    data: null,
    error: null,
    loading: path !== null,
    refreshing: false,
    path: null,
  });

  const load = useCallback(
    async (target: string, mode: "initial" | "refresh") => {
      if (!token) return;
      setState((previous) => ({
        data: previous.path === target ? previous.data : null,
        error: null,
        loading: mode === "initial" && previous.path !== target,
        refreshing: mode === "refresh",
        path: previous.path === target ? previous.path : null,
      }));
      try {
        const data = await crmGet<T>(target, key, token);
        setState({ data, error: null, loading: false, refreshing: false, path: target });
      } catch (error) {
        if (error instanceof ApiError && error.isSessionExpired) {
          await handleExpiredSession();
          return;
        }
        setState((previous) => ({
          data: previous.path === target ? previous.data : null,
          error: crmErrorMessage(error),
          loading: false,
          refreshing: false,
          path: previous.path === target ? previous.path : null,
        }));
      }
    },
    [handleExpiredSession, key, token],
  );

  useEffect(() => {
    if (path === null) {
      setState({ data: null, error: null, loading: false, refreshing: false, path: null });
      return;
    }
    void load(path, "initial");
  }, [load, path]);

  const reload = useCallback(() => {
    if (path !== null) void load(path, "refresh");
  }, [load, path]);

  const replace = useCallback((next: T) => setState((previous) => ({ ...previous, data: next, error: null })), []);

  return { data: state.data, error: state.error, loading: state.loading, refreshing: state.refreshing, reload, replace };
}

export type CrmAction = {
  /** The label of the action running now, so only its own button shows it is working. */
  busy: string | null;
  error: string | null;
  clearError: () => void;
  /** Runs one save; resolves undefined when it was refused (the sentence is in `error`). Signs out on 401/403. */
  run: <T>(label: string, work: () => Promise<T>) => Promise<T | undefined>;
};

export function useCrmAction(): CrmAction {
  const { handleExpiredSession } = useSession();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async <T,>(label: string, work: () => Promise<T>): Promise<T | undefined> => {
      setBusy(label);
      setError(null);
      try {
        return await work();
      } catch (caught) {
        if (caught instanceof ApiError && caught.isSessionExpired) {
          await handleExpiredSession();
          return undefined;
        }
        setError(crmErrorMessage(caught));
        return undefined;
      } finally {
        setBusy(null);
      }
    },
    [handleExpiredSession],
  );
  const clearError = useCallback(() => setError(null), []);

  return { busy, clearError, error, run };
}
