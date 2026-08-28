/**
 * Thin HTTP client for the iReports360 Reporting API.
 *
 * Flow (per the vendor docs): POST /api/ReportsApi/login -> JWT (30-day), then
 * GET /api/ReportsApi/visits, /checkins, /weekly-plans and /monthly-plans with a Bearer token.
 *
 * READ-ONLY EXCEPT FOR ONE WRITE, ADDED DELIBERATELY 2026-08-28. This header carried a note saying
 * the vendor's two mutating endpoints -- PUT /weekly-plans/{id}/status and
 * PUT /monthly-plans/{id}/status -- were "not implemented here, deliberately", because approving a
 * rep's plan is a real decision inside the customer's CRM and nothing in Phoenix had been asked to
 * make it. The owner has now asked for exactly that feature: a district manager verifies a rep's
 * plan, and that verification has to land in the CRM, where the rep and every other manager look.
 * `iReports360SetPlanStatus` below is that write, and it is the ONLY one. Everything else stays GET.
 *
 * The status values are the vendor's: 0 = New, 1 = Supervisor Verified, 2 = Area Manager Verified.
 * They are NOT re-declared here — `src/lib/crm/plan-verification.ts` owns that vocabulary and the
 * rule about which of them Phoenix may write. Measured against the live API 2026-08-28: the vendor
 * validates the plan id BEFORE the status value (a phantom id with `{ status: 99 }` came back 404
 * "not found", not a range error), so nothing on their side refuses a nonsense status on a real
 * plan. The range guard is ours, and it must stay ours.
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

/**
 * One planned call from GET /api/ReportsApi/weekly-plans.
 *
 * Shape confirmed against the live API 2026-08-21 — these thirteen keys and no others. Note what
 * is NOT here: an agent NAME. Unlike a visit, a plan entry identifies its rep by numeric id only,
 * so the sync resolves the employee crm-id-first exactly as a check-in does.
 *
 * `grade` and `speciality` describe the CONTACT, and are the reason this endpoint answers "what is
 * this rep's doctor list" at all: speciality was filled on 16,328 of 16,328 rows measured over
 * 1-21 August 2026.
 */
export type IReports360PlanEntry = {
  /** Vendor field `appm` (sic) — the AM/PM half-day marker, same inconsistent casing as a visit. */
  appm: string | null;
  agentID: number;
  contactID: number | null;
  contactName: string | null;
  /** Weekly only: the planned call date, zone-less Cairo wall-clock like every vendor timestamp. */
  date: string | null;
  /** Contact commercial grade (A/B/C), sent with stray casing/whitespace — normalize before use. */
  grade: string | null;
  id: number;
  /** The plan HEADER id this entry belongs to; many entries share one. */
  planID: number | null;
  /** Header approval flag: 0 = New, 1 = Supervisor Verified, 2 = Area Manager Verified. */
  planStatus: number | null;
  region: string | null;
  speciality: string | null;
  startAM: string | null;
  startPM: string | null;
};

/**
 * Returns weekly PLAN entries within an inclusive date range (YYYY-MM-DD).
 *
 * Optionally narrowed to one rep with `agentId` — the vendor supports it (verified live), and it
 * is the cheap path for a single-rep drill-down. Omit it for the whole field force.
 */
export async function iReports360GetWeeklyPlans(
  config: IReports360Config,
  token: string,
  startDate: string,
  endDate: string,
  agentId?: number,
): Promise<IReports360PlanEntry[]> {
  const url =
    `${config.baseUrl}/api/ReportsApi/weekly-plans` +
    `?startDate=${encodeURIComponent(toDateParam(startDate))}` +
    `&endDate=${encodeURIComponent(toDateParam(endDate))}` +
    (agentId ? `&agentId=${encodeURIComponent(String(agentId))}` : "");
  const payload = (await fetchJson(
    url,
    { headers: { Authorization: `Bearer ${token}` }, method: "GET" },
    config.timeoutMs,
  )) as { data?: IReports360PlanEntry[]; message?: string; success?: boolean } | null;
  if (payload?.success === false) {
    throw new IReports360ApiError(messageFromPayload(payload, "iReports360 weekly-plans request failed."), 502);
  }
  // Same rule as visits/checkins: a missing or non-array `data` is a BROKEN response, never an
  // empty one. Coercing it to [] here would let a vendor shape change wipe every rep's doctor
  // list on the next sync and report the run as a success.
  if (!payload || !Array.isArray(payload.data)) {
    throw new IReports360ApiError(
      messageFromPayload(
        payload,
        "iReports360 weekly-plans response contained no `data` array — the response shape changed or the request was rejected.",
      ),
      502,
    );
  }
  return payload.data;
}

/**
 * One entry from GET /api/ReportsApi/monthly-plans.
 *
 * Shape confirmed against the live API 2026-08-28 — these thirteen keys and no others.
 *
 * A monthly plan is NOT a weekly plan with a wider window, and the difference is the whole reason
 * this needs its own type. It carries no `date` and no `startAM`/`startPM`: instead of "see this
 * doctor on Tuesday afternoon" it says "see this doctor `frequency` times this month". So a monthly
 * entry can never be placed on a calendar day, and any reader that tries to will silently drop
 * every monthly row.
 *
 * Measured over August and July 2026: 17 and 21 reps use monthly plans, against ~80 on weekly, and
 * `frequency` ranged 0-16.
 */
export type IReports360MonthlyPlanEntry = {
  /** Vendor field `appm` (sic) — present on the type, null on every monthly row measured. */
  appm: string | null;
  agentID: number;
  contactID: number | null;
  contactName: string | null;
  /** Planned calls on this contact for the month. The monthly plan's whole payload. */
  frequency: number | null;
  grade: string | null;
  id: number;
  /** 1-12, Cairo calendar month. Monthly plans have no date at all. */
  month: number | null;
  /** The plan HEADER id this entry belongs to; many entries share one. */
  planID: number | null;
  /** Header approval flag: 0 = New, 1 = Supervisor Verified, 2 = Area Manager Verified. */
  planStatus: number | null;
  region: string | null;
  speciality: string | null;
  year: number | null;
};

/**
 * Returns MONTHLY plan entries for one Cairo calendar month.
 *
 * `month` and `year` are both required by the vendor — a date range is rejected with
 * "month and year are required parameters." (HTTP 400), so this deliberately takes neither a range
 * nor a default. There is no agent filter on this endpoint, unlike weekly-plans.
 */
export async function iReports360GetMonthlyPlans(
  config: IReports360Config,
  token: string,
  month: number,
  year: number,
): Promise<IReports360MonthlyPlanEntry[]> {
  const url =
    `${config.baseUrl}/api/ReportsApi/monthly-plans` +
    `?month=${encodeURIComponent(String(month))}&year=${encodeURIComponent(String(year))}`;
  const payload = (await fetchJson(
    url,
    { headers: { Authorization: `Bearer ${token}` }, method: "GET" },
    config.timeoutMs,
  )) as { data?: IReports360MonthlyPlanEntry[]; message?: string; success?: boolean } | null;
  if (payload?.success === false) {
    throw new IReports360ApiError(messageFromPayload(payload, "iReports360 monthly-plans request failed."), 502);
  }
  // Same rule as visits/checkins/weekly-plans: a missing or non-array `data` is a BROKEN response,
  // never an empty one. Coercing it to [] would let a vendor shape change empty a month of plans
  // and report the run as a success.
  if (!payload || !Array.isArray(payload.data)) {
    throw new IReports360ApiError(
      messageFromPayload(
        payload,
        "iReports360 monthly-plans response contained no `data` array — the response shape changed or the request was rejected.",
      ),
      502,
    );
  }
  return payload.data;
}

/**
 * THE ONE WRITE. Sets a plan header's approval status in the CRM.
 *
 * `PUT /api/ReportsApi/{weekly|monthly}-plans/{planId}/status` with `{ status }`. Verified against
 * the live API 2026-08-28 using a plan id that cannot exist (999999999), so nothing real was
 * touched: both kinds answered HTTP 404 with "Weekly plan not found." / "Monthly plan not found.",
 * POST answered 405, an empty body answered 400, and an unauthenticated call answered 401. The
 * route, the verb and the auth are therefore all confirmed without a single real plan being moved.
 *
 * `status` is NOT validated here beyond being an integer, and that is not an oversight — the guard
 * belongs one level up, in `decidePlanVerification`, which is the only thing that decides what
 * Phoenix is entitled to write and is pure enough to be tested exhaustively. Callers must not reach
 * this function with a status they invented.
 *
 * Throws `IReports360ApiError` carrying the vendor's own message on any non-2xx, so a caller can
 * report "Weekly plan not found." rather than a generic failure — and, crucially, so a failed CRM
 * write can never be mistaken for a successful one by the code that updates Phoenix's mirror.
 */
export async function iReports360SetPlanStatus(
  config: IReports360Config,
  token: string,
  input: { kind: "weekly" | "monthly"; planId: number; status: number },
): Promise<void> {
  if (!Number.isInteger(input.planId) || input.planId <= 0) {
    throw new IReports360ApiError(`Refusing to set the status of plan id ${input.planId}.`, 400);
  }
  if (!Number.isInteger(input.status)) {
    throw new IReports360ApiError(`Refusing to write a non-integer plan status (${input.status}).`, 400);
  }
  const url = `${config.baseUrl}/api/ReportsApi/${input.kind}-plans/${encodeURIComponent(String(input.planId))}/status`;
  const payload = (await fetchJson(
    url,
    {
      body: JSON.stringify({ status: input.status }),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      method: "PUT",
    },
    config.timeoutMs,
  )) as { message?: string; success?: boolean } | null;
  // A 2xx carrying `success: false` is the vendor's other way of refusing. Treated as a failure, so
  // the mirror is never stamped verified off a request the CRM declined.
  if (payload?.success === false) {
    throw new IReports360ApiError(
      messageFromPayload(payload, `iReports360 refused to set the ${input.kind} plan status.`),
      502,
    );
  }
}
