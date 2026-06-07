/**
 * Thin, read-only HTTP client for the iReports360 Reporting API.
 *
 * Flow (per the vendor docs): POST /api/ReportsApi/login -> JWT (30-day), then
 * GET /api/ReportsApi/visits and /checkins with a Bearer token, by date range.
 * The API is read-only; this client never mutates the CRM.
 */

import type { IReports360Config } from "@/lib/field-workforce-compliance/ireports360-config";

export type IReports360Visit = {
  agentID: number;
  agentName: string | null;
  ampm: string | null;
  attendance: number | null;
  callType: number | null;
  comment: string | null;
  contactID: number | null;
  contactName: string | null;
  customerName: string | null;
  doubleID: number | null;
  doubleName: string | null;
  id: number;
  saveDate: string | null;
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
      response.status === 401 ? 401 : 502,
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
  )) as { data?: IReports360Visit[] } | null;
  return Array.isArray(payload?.data) ? payload.data : [];
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
  )) as { data?: IReports360Checkin[] } | null;
  return Array.isArray(payload?.data) ? payload.data : [];
}
