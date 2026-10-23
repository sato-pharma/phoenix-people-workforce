"use client";

/**
 * Phoenix CRM — how the screens talk to /api/phoenix-crm.
 *
 * Every route answers `{ <key>: …, success: true }` or `{ error, message, success: false }`, and a
 * refusal's `message` is a sentence written for the person who pressed the button (see
 * src/lib/phoenix-crm/server/http.ts). So a screen shows `error.message` as it is, and branches on
 * `error.code` only where a refusal asks a question back (a customer with the same name, a plan that
 * moved on).
 */

import { useCallback, useEffect, useState } from "react";

export class CrmRequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "CrmRequestError";
    this.code = code;
    this.status = status;
  }
}

type Envelope = Record<string, unknown>;

const OFFLINE_MESSAGE = "No connection. Check the phone's internet and try again.";
const SIGNED_OUT_MESSAGE = "You are signed out. Sign in again, then try once more.";

async function request<T>(url: string, init: RequestInit, key: string, fallback: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { cache: "no-store", ...init });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new CrmRequestError(OFFLINE_MESSAGE, "offline", 0);
  }
  const body = (await response.json().catch(() => null)) as Envelope | null;
  if (response.ok && body && body.success === true) return body[key] as T;
  if (response.status === 401) throw new CrmRequestError(SIGNED_OUT_MESSAGE, "signed_out", 401);
  const code = typeof body?.error === "string" && body.error ? body.error : "failed";
  const message = typeof body?.message === "string" && body.message.trim() ? body.message.trim() : fallback;
  throw new CrmRequestError(message, code, response.status);
}

export function crmGet<T>(url: string, key: string, signal?: AbortSignal): Promise<T> {
  return request<T>(url, { signal }, key, "Phoenix could not load this. Try again.");
}

/**
 * `keepalive` lets the request outlive the page — the plan's own save, flushed as the page is hidden or
 * closed (owner, 2026-10-02: the rep's board saves itself), so a tick made a second before is not lost.
 */
export function crmPost<T>(path: string, payload: unknown, key: string, options: { keepalive?: boolean } = {}): Promise<T> {
  return request<T>(
    path,
    {
      body: JSON.stringify(payload),
      headers: { "content-type": "application/json" },
      method: "POST",
      ...(options.keepalive ? { keepalive: true } : {}),
    },
    key,
    "Phoenix could not save this. Try again.",
  );
}

/**
 * A PATCH, answered like a save. It carries a body and it is for an edit of something already saved —
 * a manager's write-up on a visit he logged — so the route can keep that apart from the POST that
 * created it without a discriminator in the payload.
 */
export function crmPatch<T>(path: string, payload: unknown, key: string): Promise<T> {
  return request<T>(
    path,
    { body: JSON.stringify(payload), headers: { "content-type": "application/json" }, method: "PATCH" },
    key,
    "Phoenix could not save this. Try again.",
  );
}

/** A DELETE, answered like a save: the value under `key`, or a refusal with the server's sentence. */
export function crmDelete<T>(url: string, key: string): Promise<T> {
  return request<T>(url, { method: "DELETE" }, key, "Phoenix could not delete this. Try again.");
}

/** A GET path with its query. Empty, null and false values are left out (a flag is on only when sent). */
export function crmUrl(path: string, params: Record<string, string | number | boolean | null | undefined> = {}): string {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "" || value === false) continue;
    search.set(name, value === true ? "true" : String(value));
  }
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

export function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return "Something went wrong. Try again.";
}

export function errorCodeOf(error: unknown): string | null {
  return error instanceof CrmRequestError ? error.code : null;
}

/**
 * A fresh id for a save that may be sent twice (a visit retried after a dropped connection). Called
 * in event handlers only — never while rendering.
 */
export function newClientId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type CrmResource<T> = {
  /** The last answer for this same URL — kept on screen while a reload runs. */
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
  /** Put a fresh view a save answered with straight on screen, without another read. */
  replace: (next: T) => void;
};

type LoadState<T> = { data: T | null; error: string | null; tag: string | null; url: string | null };

/**
 * Reads one view. `url` null = nothing to read yet. Changing the URL shows nothing from the old one
 * (another territory's list must never sit under this territory's name); a reload of the same URL
 * keeps the last answer on screen until the new one arrives.
 */
export function useCrmGet<T>(url: string | null, key: string): CrmResource<T> {
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<LoadState<T>>({ data: null, error: null, tag: null, url: null });

  useEffect(() => {
    if (url === null) return;
    const controller = new AbortController();
    const tag = `${nonce}|${url}`;
    // 🔴 SUPERSEDED, NOT ABORTED. The old guard was `if (controller.signal.aborted) return`, which
    // is right for OUR OWN cleanup — another run of this effect is already on its way with a new
    // tag, so leaving the state alone is correct — and wrong for an abort from anywhere else. A
    // phone drops in-flight requests when the tab is backgrounded or the network switches between
    // 4G and WiFi, and a deploy drops them too. That rejection was then swallowed: `state` kept the
    // PREVIOUS tag, so `loading` below stayed true for ever.
    //
    // A stuck `loading` is not a spinner. `data` survives (same URL), so the page renders normally
    // with the last answer, and `error` stays null so no load error and no Retry is offered — but
    // every screen derives `locked` from it, and every button is disabled on `locked`. The result
    // is a page that looks perfectly healthy where Save, Send and the week switcher silently do
    // NOTHING, with no message and nothing to press. It survives until the tab is reloaded, and
    // `reload()` runs after every save, so one dropped request poisons the screen.
    //
    // So only our own cleanup may swallow the rejection; every other abort surfaces as a load error
    // with a Retry, like any other failed read.
    let superseded = false;
    crmGet<T>(url, key, controller.signal).then(
      (data) => {
        if (superseded) return;
        setState({ data, error: null, tag, url });
      },
      (error: unknown) => {
        if (superseded) return;
        setState((current) => ({ data: current.url === url ? current.data : null, error: messageOf(error), tag, url }));
      },
    );
    return () => {
      superseded = true;
      controller.abort();
    };
  }, [key, nonce, url]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  const replace = useCallback((next: T) => setState((current) => ({ ...current, data: next, error: null })), []);

  const tag = url === null ? null : `${nonce}|${url}`;
  return {
    data: url !== null && state.url === url ? state.data : null,
    error: tag !== null && state.tag === tag ? state.error : null,
    loading: tag !== null && state.tag !== tag,
    reload,
    replace,
  };
}

export type CrmAction = {
  /** The label of the action running now, so only its own button shows it is working. */
  busy: string | null;
  error: string | null;
  clearError: () => void;
  /** Runs one save; resolves undefined when it was refused (the sentence is in `error`). */
  run: <T>(label: string, work: () => Promise<T>) => Promise<T | undefined>;
};

export function useCrmAction(): CrmAction {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async <T,>(label: string, work: () => Promise<T>): Promise<T | undefined> => {
    setBusy(label);
    setError(null);
    try {
      return await work();
    } catch (caught) {
      setError(messageOf(caught));
      return undefined;
    } finally {
      setBusy(null);
    }
  }, []);
  const clearError = useCallback(() => setError(null), []);

  return { busy, clearError, error, run };
}
