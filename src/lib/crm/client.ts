/**
 * Thin, read-only HTTP client for the iReports360 Reporting API.
 *
 * Flow (per the vendor docs): POST /api/ReportsApi/login -> JWT (30-day), then
 * GET /api/ReportsApi/visits and /checkins with a Bearer token, by date range.
 * The API is read-only; this client never mutates the CRM.
 *
 * This is the single HTTP boundary to the CRM. Nothing outside `src/lib/crm/`
 * should import it directly — consumers go through the CRM read/sync services.
 */

import type { IReports360Config } from "@/lib/crm/config";

export type IReports360Visit = {
  agentID: number;
  agentName: string | null;
  ampm: string | null;
  attendance: number | null;
  callType: number | null;
  comment: string | null;
  contactID: number | null;
  contactName: string | null;
  // Added by the vendor 2026-07-24: the visited contact's commercial potential grade
  // (A+/A/B/C — A highest). Sent with inconsistent casing/whitespace ("b", " A", "B   ") — the
  // sync engine normalizes it (see normalizeContactGrade in sync.ts) before storing. Same
  // customer-visits-only population pattern as region/speciality below.
  contactGrade: string | null;
  customerName: string | null;
  doubleID: number | null;
  doubleName: string | null;
  id: number;
  // Added by the vendor 2026-07-22: the visited contact's locality (region/regionID) and medical
  // specialty. Populated on regular customer visits only (visitType 0); null on campaign/meeting/
  // leave entries, which carry no real contact. Finer-grained than Phoenix's own au.regions.
  region: string | null;
  regionID: number | null;
  saveDate: string | null;
  speciality: string | null;
  visitDate: string;
  visitType: number;
  visitTypeDescription: string | null;
};

export type IReports360Checkin = {
  address: string | null;
  agentID: number;
  checkDate: string;
  contactID: number | null;
  contactName: string | null;
  id: number;
  lat: number | null;
  lon: number | null;
};

export class IReports360ApiError extends Error {
  status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.name = "IReports360ApiError";
    this.status = status;
  }
}

function normalizeHttpStatus(status: number): number {
  if (!Number.isFinite(status) || status < 100 || status > 599) return 502;
  if (status === 401 || status === 400 || status === 403 || status === 404 || status === 409 || status === 429) return status;
  if (status >= 500 && status <= 599) return status;
  return 502;
}

function messageFromPayload(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object" && "message" in payload) {
    const message = (payload as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, { ...init, cache: "no-store", signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new IReports360ApiError("iReports360 request timed out.", 504);
    }
    throw new IReports360ApiError(
      `iReports360 request failed: ${error instanceof Error ? error.message : "network error"}.`,
      502,
    );
  } finally {
    clearTimeout(timer);
  }

  const body = await response.text();
  let payload: unknown = null;
  try {
    payload = body ? JSON.parse(body) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw new IReports360ApiError(
      messageFromPayload(payload, `iReports360 responded with HTTP ${response.status}.`),
      normalizeHttpStatus(response.status),
    );
  }

  return payload;
}

/** Authenticates and returns a JWT token (valid ~30 days per the API docs). */
export async function iReports360Login(config: IReports360Config): Promise<string> {
  const payload = (await fetchJson(
    `${config.baseUrl}/api/ReportsApi/login`,
    {
      body: JSON.stringify({ password: config.password, username: config.username }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
    config.timeoutMs,
  )) as { message?: string; success?: boolean; token?: string } | null;

  if (payload?.success === false) {
    throw new IReports360ApiError(messageFromPayload(payload, "iReports360 login failed."), 401);
  }

  if (!payload?.token) {
    throw new IReports360ApiError(
      messageFromPayload(payload, "iReports360 login did not return a token."),
      401,
    );
  }
  return payload.token;
}

function toDateParam(value: string): string {
  return value.slice(0, 10);
}

/** Returns visit records within an inclusive date range (YYYY-MM-DD). */
export async function iReports360GetVisits(
  config: IReports360Config,
  token: string,
  startDate: string,
  endDate: string,
): Promise<IReports360Visit[]> {
  const url =
    `${config.baseUrl}/api/ReportsApi/visits` +
    `?startDate=${encodeURIComponent(toDateParam(startDate))}` +
    `&endDate=${encodeURIComponent(toDateParam(endDate))}`;
  const payload = (await fetchJson(
    url,
    { headers: { Authorization: `Bearer ${token}` }, method: "GET" },
    config.timeoutMs,
  )) as { data?: IReports360Visit[]; message?: string; success?: boolean } | null;
  if (payload?.success === false) {
    throw new IReports360ApiError(messageFromPayload(payload, "iReports360 visits request failed."), 502);
  }
  // A missing/non-array `data` is a BROKEN response, not an empty one, and the two must never look
  // alike: coercing it to [] made the sync record a green "success, 0 rows fetched" run, ping the
  // dead-man's switch as healthy, and send a ✅ notification — so a renamed field, an auth-scope
  // change, or a nested-shape change could stop the integration for days with no signal anywhere.
  // `data: []` is still perfectly valid and returns [] (a genuinely quiet day).
  if (!payload || !Array.isArray(payload.data)) {
    throw new IReports360ApiError(
      messageFromPayload(
        payload,
        "iReports360 visits response contained no `data` array — the response shape changed or the request was rejected.",
      ),
      502,
    );
  }
  return payload.data;
}

/** Returns GPS check-in records within an inclusive date range (YYYY-MM-DD). */
export async function iReports360GetCheckins(
  config: IReports360Config,
  token: string,
  startDate: string,
  endDate: string,
): Promise<IReports360Checkin[]> {
  const url =
    `${config.baseUrl}/api/ReportsApi/checkins` +
    `?startDate=${encodeURIComponent(toDateParam(startDate))}` +
    `&endDate=${encodeURIComponent(toDateParam(endDate))}`;
  const payload = (await fetchJson(
    url,
    { headers: { Authorization: `Bearer ${token}` }, method: "GET" },
    config.timeoutMs,
  )) as { data?: IReports360Checkin[]; message?: string; success?: boolean } | null;
  if (payload?.success === false) {
    throw new IReports360ApiError(messageFromPayload(payload, "iReports360 checkins request failed."), 502);
  }
  // See iReports360GetVisits: a broken response must not be indistinguishable from an empty one.
  // This one matters even more, because the sync's check-in fetch is wrapped in `.catch(() => [])`,
  // so a permanently-broken /checkins endpoint would otherwise degrade every visit's GPS time tier
  // to save-time silently and forever.
  if (!payload || !Array.isArray(payload.data)) {
    throw new IReports360ApiError(
      messageFromPayload(
        payload,
        "iReports360 checkins response contained no `data` array — the response shape changed or the request was rejected.",
      ),
      502,
    );
  }
  return payload.data;
}
