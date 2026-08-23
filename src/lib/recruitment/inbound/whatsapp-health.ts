// Recruitment / ATS — liveness check for inbound WhatsApp CV intake.
//
// Why this exists: on 2026-07-26 Meta blocked API access for the Phoenix WhatsApp app (every
// Graph call returned OAuthException 200 "API access blocked") and simply stopped delivering
// webhooks. Nothing in this system noticed. The webhook route only runs when Meta calls it, so a
// Meta-side block produces exactly zero signal — no error, no failed cron, no log line — and the
// outage was found ~19 hours later by a human asking why no CVs had arrived.
//
// Two complementary checks, deliberately different in kind:
//
//   1. API probe (deterministic). One cheap authenticated GET against the phone-number node. An
//      app-level block, a revoked/expired token, or a deleted number all fail here immediately
//      and unambiguously. This is what actually catches the incident above.
//   2. Inbound silence (heuristic, gated to Cairo working time). Catches the cases the probe
//      cannot: the WABA quietly unsubscribed from the app, or the callback URL pointing somewhere
//      else — the credentials still work, the messages just never arrive. Volume on this channel
//      is low, so the threshold is generous and it only ever fires during Cairo working hours on a
//      Cairo working day.
//
// Read-only and side-effect free: it reports, the caller decides what to log or fail.

import { systemDeployment } from "@/config/system-settings";
import { isFieldWorkforceWeeklyOff } from "@/lib/field-workforce-compliance/weekend-policy";
import { PHOENIX_BUSINESS_TIME_ZONE } from "@/lib/i18n/format";
import { recruitmentDb } from "@/lib/recruitment/db";

const DEFAULT_GRAPH_API_VERSION = "v23.0";
const DEFAULT_SILENCE_ALERT_HOURS = 24;
const PROBE_TIMEOUT_MS = 8_000;

// Cairo working hours during which an absence of inbound CVs is genuinely suspicious. Outside
// this window silence is normal and must never page anyone.
const BUSINESS_HOUR_START = 10;
const BUSINESS_HOUR_END = 20;

export type WhatsAppIntakeHealthStatus =
  | "ok"
  | "not_configured"
  | "api_unreachable"
  | "webhook_misrouted"
  | "silent";

/** The webhook path Meta must call. Mirrors app/api/webhooks/whatsapp/route.ts. */
const WEBHOOK_PATH = "/api/webhooks/whatsapp";

/** The callback URL Meta is supposed to hold, derived from the one configured production URL. */
export function expectedWebhookUrl(): string {
  return `${systemDeployment.productionUrl.replace(/\/+$/, "")}${WEBHOOK_PATH}`;
}

/**
 * Trailing slashes and case in the host are not meaningful to Meta, so they must not be meaningful
 * here either — otherwise this check invents an outage out of a cosmetic difference.
 */
export function normalizeCallbackUrl(url: string | null | undefined): string | null {
  const raw = (url ?? "").trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}`;
  } catch {
    return raw.replace(/\/+$/, "");
  }
}

/**
 * Where Meta is currently configured to deliver inbound messages, and whether that is us.
 *
 * `ok: null` means the question could not be answered (no app secret, or Graph unreachable). That
 * is deliberately NOT the same as `false` — an unanswerable check must never be reported as a
 * healthy one, and must never page as if it were a confirmed outage.
 */
export type WhatsAppWebhookRouting = {
  ok: boolean | null;
  /** Callback URL on the app-level subscription, as Meta currently holds it. */
  callbackUrl: string | null;
  /** Meta disables a subscription that keeps failing; nothing arrives once it does. */
  active: boolean | null;
  /** Without the `messages` field subscribed, config looks fine and no CV ever arrives. */
  messagesSubscribed: boolean | null;
  /** A per-number override, when the number carries one. It wins over the app-level URL. */
  numberOverrideUrl: string | null;
  /** Human-readable reasons, safe to put straight into a log or an alert. */
  problems: string[];
};

/**
 * Turns the raw Graph answers into a routing verdict. Pure, so every failure mode is testable
 * without touching Meta.
 *
 * This is the check that replaces "we have not heard anything in a while" as the thing that pages.
 * Silence cannot distinguish a dead webhook from a quiet week — measured on this channel, a normal
 * gap has reached 333 hours against a 96-hour threshold — whereas each condition below is a
 * deterministic fact about how Meta is configured RIGHT NOW.
 */
export function evaluateWebhookRouting(input: {
  expectedCallbackUrl: string;
  /** The `whatsapp_business_account` entry of GET /{app-id}/subscriptions, or null if absent. */
  subscription: { active?: boolean; callback_url?: string; fields?: Array<{ name?: string }> } | null;
  /** webhook_configuration.application on the phone number, when set. */
  numberOverrideUrl: string | null;
  /** False when the check could not run at all (missing app secret, Graph error). */
  answerable: boolean;
}): WhatsAppWebhookRouting {
  const expected = normalizeCallbackUrl(input.expectedCallbackUrl);
  const callbackUrl = input.subscription?.callback_url ?? null;
  const active = input.subscription?.active ?? null;
  const messagesSubscribed = input.subscription
    ? (input.subscription.fields ?? []).some((field) => field?.name === "messages")
    : null;
  const numberOverrideUrl = input.numberOverrideUrl;

  const base = { active, callbackUrl, messagesSubscribed, numberOverrideUrl };
  if (!input.answerable) {
    return { ...base, ok: null, problems: [] };
  }

  const problems: string[] = [];
  if (!input.subscription) {
    problems.push("the app has no whatsapp_business_account webhook subscription at all");
  } else {
    if (active === false) problems.push("Meta has DISABLED the webhook subscription");
    if (messagesSubscribed === false) problems.push('the "messages" webhook field is not subscribed');
    const actual = normalizeCallbackUrl(callbackUrl);
    if (actual !== expected) {
      problems.push(`the callback URL is ${actual ?? "unset"}, not ${expected}`);
    }
  }
  // An override on the number wins over the app-level URL, so a wrong one silently reroutes every
  // message even when everything above looks correct.
  const override = normalizeCallbackUrl(numberOverrideUrl);
  if (override !== null && override !== expected) {
    problems.push(`the number's own webhook override points at ${override}, not ${expected}`);
  }

  return { ...base, ok: problems.length === 0, problems };
}

/** Per-number result of the Graph API probe. */
export type WhatsAppNumberProbe = {
  phoneNumberId: string;
  ok: boolean;
  /** Meta's reported display number when it resolved, for readable logs. */
  displayNumber: string | null;
  /** Meta's own error text (or a status like "number status is FLAGGED") when unhealthy, else null. */
  error: string | null;
  /** Last inbound CV recorded on THIS line (ISO), populated by checkWhatsAppIntakeHealth. */
  lastInboundAt?: string | null;
};

/**
 * Whether one line is "silent" — the API says the number is healthy, yet it has stopped receiving.
 * Only counts when the line HAS received before (no history = a freshly-added line, not a
 * regression) and only inside the Cairo alert window. Pure, so the rule is testable. A down line is
 * NOT "silent" here — that is already reported as api_unreachable, and double-reporting one incident
 * is just noise.
 */
export function isNumberSilent(input: {
  ok: boolean;
  lastInboundAt: Date | null;
  now: Date;
  thresholdHours: number;
}): boolean {
  if (!input.ok || !input.lastInboundAt) return false;
  const hours = (input.now.getTime() - input.lastInboundAt.getTime()) / (60 * 60 * 1000);
  return hours > input.thresholdHours && isSilenceAlertWindow(input.now);
}

export type WhatsAppIntakeHealthCore = {
  status: WhatsAppIntakeHealthStatus;
  /** Aggregate of every failing number's error, else null. */
  apiError: string | null;
  lastInboundAt: string | null;
  hoursSinceLastInbound: number | null;
  /** Where Meta is configured to deliver, and whether that is still us. Null when unanswerable. */
  routing: WhatsAppWebhookRouting | null;
  /** One-line explanation, safe to put straight into a log message. */
  detail: string;
};

export type WhatsAppIntakeHealth = WhatsAppIntakeHealthCore & {
  /** One entry per configured intake number. Empty when the channel is not configured. */
  probes: WhatsAppNumberProbe[];
};

function graphApiVersion(): string {
  return process.env.WHATSAPP_GRAPH_API_VERSION?.trim() || DEFAULT_GRAPH_API_VERSION;
}

/**
 * The intake phone-number IDs to health-check. `WHATSAPP_PHONE_NUMBER_IDS` (comma-separated) is
 * the multi-line form; if unset it falls back to the single `WHATSAPP_PHONE_NUMBER_ID` so nothing
 * changes until a second number is actually added. Deduped, order preserved.
 */
export function resolveConfiguredPhoneNumberIds(): string[] {
  const multi = (process.env.WHATSAPP_PHONE_NUMBER_IDS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (multi.length > 0) return Array.from(new Set(multi));
  const single = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  return single ? [single] : [];
}

/**
 * Collapses per-number probe results into one error string (or null when all healthy). Pure, so
 * the aggregation rule is unit-testable without hitting Meta.
 */
export function aggregateProbeError(probes: readonly WhatsAppNumberProbe[]): string | null {
  const failed = probes.filter((probe) => !probe.ok);
  if (failed.length === 0) return null;
  return failed.map((probe) => `${probe.displayNumber ?? probe.phoneNumberId}: ${probe.error ?? "unreachable"}`).join("; ");
}

function silenceAlertHours(): number {
  const raw = Number(process.env.RECRUITMENT_WHATSAPP_SILENCE_ALERT_HOURS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SILENCE_ALERT_HOURS;
}

/** Hour of day (0-23) in Africa/Cairo — the business timezone every other scheduled job uses. */
export function cairoHour(now: Date): number {
  const value = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    hour12: false,
    timeZone: PHOENIX_BUSINESS_TIME_ZONE,
  }).format(now);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed % 24 : 12;
}

export function isCairoBusinessHours(now: Date): boolean {
  const hour = cairoHour(now);
  return hour >= BUSINESS_HOUR_START && hour < BUSINESS_HOUR_END;
}

/**
 * A Cairo working DAY — i.e. not the Egyptian weekend. Delegates to the company weekend policy
 * (no job title = the office rule: Friday and Saturday off) so this check and attendance cannot
 * drift apart on what "the weekend" means.
 */
export function isCairoBusinessDay(now: Date): boolean {
  return !isFieldWorkforceWeeklyOff({ dateIso: cairoDateKey(now) });
}

/**
 * The window in which inbound silence is worth alerting on: Cairo working hours ON a Cairo working
 * day.
 *
 * The day half was missing until 2026-07-31 and it mattered: with only the hours gate, a channel
 * that is simply quiet over the Friday-Saturday weekend logs the "not healthy" error on all six
 * cron ticks an hour, for the full ten-hour window — 60 errors per weekend day, each one also
 * waking the production ERROR log alert. That happened for real (Thu 07-30 and Fri 07-31, 120
 * errors) while every Meta-side check — subscription active, callback URL correct, number
 * CONNECTED — passed. Nobody had sent a CV; the alert was measuring the weekend.
 *
 * Note this gates WHEN we alert, not how the gap is measured: hours since the last CV still
 * accumulate across the weekend, so a webhook that genuinely dies on Thursday night is reported on
 * Sunday morning — the first working hour a human would act on it — rather than being forgotten.
 */
export function isSilenceAlertWindow(now: Date): boolean {
  return isCairoBusinessDay(now) && isCairoBusinessHours(now);
}

/**
 * Africa/Cairo YYYY-MM-DD. Used as the once-per-day throttle bucket for the push alert, so the
 * every-10-minute cron raises at most one Telegram/push notification per status per day instead
 * of spamming while an outage persists.
 */
export function cairoDateKey(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: PHOENIX_BUSINESS_TIME_ZONE,
    year: "numeric",
  }).format(now);
}

/**
 * Turns raw probe + last-inbound facts into a status. Pure, so the alerting rules can be tested
 * without touching Meta or the database.
 *
 * Order matters: a failed API probe outranks silence, because when the credentials are dead the
 * silence is a symptom, not a second independent problem — reporting both would just double the
 * noise for one incident.
 */
export function evaluateWhatsAppIntakeHealth(input: {
  configured: boolean;
  apiError: string | null;
  lastInboundAt: Date | null;
  now: Date;
  silenceThresholdHours: number;
  /** Omitted or null when routing could not be checked — never treated as a pass or a failure. */
  routing?: WhatsAppWebhookRouting | null;
}): WhatsAppIntakeHealthCore {
  const lastInboundAt = input.lastInboundAt ? input.lastInboundAt.toISOString() : null;
  const hoursSinceLastInbound = input.lastInboundAt
    ? (input.now.getTime() - input.lastInboundAt.getTime()) / (60 * 60 * 1000)
    : null;
  const routing = input.routing ?? null;
  const base = { apiError: input.apiError, hoursSinceLastInbound, lastInboundAt, routing };

  if (!input.configured) {
    return { ...base, detail: "WhatsApp intake is not configured (no access token).", status: "not_configured" };
  }

  if (input.apiError) {
    return {
      ...base,
      detail: `WhatsApp Cloud API is rejecting our credentials: ${input.apiError}`,
      status: "api_unreachable",
    };
  }

  // A deterministic misconfiguration outranks silence, because it EXPLAINS the silence and is the
  // one thing here that is actionable without guesswork. This is the check that actually catches
  // the 2026-07-26 failure mode; the silence heuristic below never could.
  if (routing && routing.ok === false) {
    return {
      ...base,
      detail: `Meta will not deliver inbound WhatsApp messages here: ${routing.problems.join("; ")}.`,
      status: "webhook_misrouted",
    };
  }

  // No inbound message has EVER arrived — nothing to compare against, so this cannot be called a
  // regression. Staying quiet here is what keeps the check inert on a freshly connected number.
  if (hoursSinceLastInbound === null) {
    return { ...base, detail: "No inbound WhatsApp message recorded yet.", status: "ok" };
  }

  if (hoursSinceLastInbound > input.silenceThresholdHours && isSilenceAlertWindow(input.now)) {
    // The old wording ended "check the WABA's webhook subscription and callback URL" — advice that
    // is now stale, because `fetchWebhookRouting` has just checked exactly those two things. Say
    // what was verified instead, so nobody re-does by hand the work the check already did.
    // Only three states can reach here: verified healthy, unanswerable, or no routing object at
    // all — `ok === false` already returned above as webhook_misrouted. So anything that is not a
    // confirmed pass must read as "not verified"; there is no silent third case to fall through to.
    const routingNote =
      routing?.ok === true
        ? " Delivery config was verified healthy, so this is a quiet channel, not a broken one."
        : " Delivery config could not be verified on this run.";
    return {
      ...base,
      detail: `No inbound WhatsApp message for ${Math.floor(hoursSinceLastInbound)}h (threshold ${input.silenceThresholdHours}h).${routingNote}`,
      status: "silent",
    };
  }

  return { ...base, detail: `Last inbound WhatsApp message ${Math.floor(hoursSinceLastInbound)}h ago.`, status: "ok" };
}

/**
 * One authenticated read against a single phone-number node. Never throws — a probe is
 * diagnostics, not a workload. A number that resolves but is not CONNECTED (FLAGGED, RESTRICTED,
 * PENDING, …) counts as unhealthy: that is how a per-number restriction shows up while the token
 * itself is still valid.
 */
export async function probeWhatsAppNumber(phoneNumberId: string, token: string): Promise<WhatsAppNumberProbe> {
  try {
    const response = await fetch(
      `https://graph.facebook.com/${graphApiVersion()}/${phoneNumberId}?fields=id,display_phone_number,status`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) },
    );
    const body = (await response.json().catch(() => null)) as
      | { display_phone_number?: string; status?: string; error?: { message?: string; code?: number } }
      | null;

    if (response.ok) {
      const displayNumber = body?.display_phone_number ?? null;
      const status = body?.status;
      if (status && status !== "CONNECTED") {
        return { displayNumber, error: `number status is ${status}`, ok: false, phoneNumberId };
      }
      return { displayNumber, error: null, ok: true, phoneNumberId };
    }

    // Meta's error body is far more actionable than the status code ("API access blocked" vs a
    // bare 400), so surface its message when there is one.
    const message = body?.error?.message?.trim();
    const code = body?.error?.code;
    return {
      displayNumber: null,
      error: message ? `${message}${code === undefined ? "" : ` (code ${code})`}` : `HTTP ${response.status}`,
      ok: false,
      phoneNumberId,
    };
  } catch (error) {
    return { displayNumber: null, error: error instanceof Error ? error.message : "probe failed", ok: false, phoneNumberId };
  }
}

/** Probes every configured intake number concurrently. Empty when the channel is not configured. */
export async function probeAllWhatsAppNumbers(): Promise<WhatsAppNumberProbe[]> {
  const token = process.env.WHATSAPP_ACCESS_TOKEN?.trim();
  const ids = resolveConfiguredPhoneNumberIds();
  if (!token || ids.length === 0) return [];
  return Promise.all(ids.map((id) => probeWhatsAppNumber(id, token)));
}

/**
 * Reads how Meta is ACTUALLY configured to deliver, using only credentials the app already holds.
 *
 * The app id is read back from `debug_token` rather than added as another environment variable —
 * one more var is one more thing that can silently drift from the token beside it. The app-level
 * subscription needs an app access token (`{app-id}|{app-secret}`), which is why this is skipped
 * entirely when `WHATSAPP_APP_SECRET` is unset: unanswerable, not unhealthy.
 *
 * Never throws. A Graph failure yields `ok: null`, so a transient network blip cannot page anyone
 * with a fake misconfiguration.
 */
export async function fetchWebhookRouting(): Promise<WhatsAppWebhookRouting> {
  const token = process.env.WHATSAPP_ACCESS_TOKEN?.trim();
  const appSecret = process.env.WHATSAPP_APP_SECRET?.trim();
  const expectedCallbackUrl = expectedWebhookUrl();
  const unanswerable = () =>
    evaluateWebhookRouting({ answerable: false, expectedCallbackUrl, numberOverrideUrl: null, subscription: null });

  if (!token || !appSecret) return unanswerable();

  const get = async (path: string, bearer: string): Promise<unknown | null> => {
    try {
      const response = await fetch(`https://graph.facebook.com/${graphApiVersion()}/${path}`, {
        headers: { Authorization: `Bearer ${bearer}` },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (!response.ok) return null;
      return (await response.json().catch(() => null)) as unknown;
    } catch {
      return null;
    }
  };

  const debug = (await get(`debug_token?input_token=${encodeURIComponent(token)}`, token)) as
    | { data?: { app_id?: string } }
    | null;
  const appId = debug?.data?.app_id?.trim();
  if (!appId) return unanswerable();

  const subs = (await get(`${appId}/subscriptions`, `${appId}|${appSecret}`)) as
    | { data?: Array<{ object?: string; active?: boolean; callback_url?: string; fields?: Array<{ name?: string }> }> }
    | null;
  if (!subs || !Array.isArray(subs.data)) return unanswerable();

  const subscription = subs.data.find((entry) => entry?.object === "whatsapp_business_account") ?? null;

  // A per-number override beats the app-level URL, so every configured number is checked. Report the
  // first one that disagrees with the expected URL; failing that, the first override that exists.
  const overrides = await Promise.all(
    resolveConfiguredPhoneNumberIds().map(async (id) => {
      const node = (await get(`${id}?fields=webhook_configuration`, token)) as
        | { webhook_configuration?: { application?: string } }
        | null;
      return node?.webhook_configuration?.application ?? null;
    }),
  );
  const expectedNormalized = normalizeCallbackUrl(expectedCallbackUrl);
  const numberOverrideUrl =
    overrides.find((url) => url !== null && normalizeCallbackUrl(url) !== expectedNormalized) ??
    overrides.find((url) => url !== null) ??
    null;

  return evaluateWebhookRouting({ answerable: true, expectedCallbackUrl, numberOverrideUrl, subscription });
}

async function lastInboundWhatsAppAt(): Promise<Date | null> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("ats_cv_intake_events")
    .select("created_at")
    .eq("channel", "whatsapp")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  const raw = (data as { created_at?: string } | null)?.created_at;
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// Last inbound CV that arrived ON a specific line, via the deliveredToPhoneNumberId now stamped on
// every WhatsApp intake event's raw_metadata. Returns null for a line with no such history yet.
async function lastInboundWhatsAppAtByNumber(phoneNumberId: string): Promise<Date | null> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("ats_cv_intake_events")
    .select("created_at")
    .eq("channel", "whatsapp")
    .eq("raw_metadata->>deliveredToPhoneNumberId", phoneNumberId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  const raw = (data as { created_at?: string } | null)?.created_at;
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Composes the per-number API probes + a channel-wide silence window + a PER-NUMBER silence check
 * into one reportable status. Per-number silence uses the `deliveredToPhoneNumberId` stamped on each
 * intake event, so a line that goes quiet while another stays busy is caught (a channel-wide check
 * would miss it). A line with no history yet is never flagged, so a freshly-added number stays
 * inert until it has actually received. Order of precedence: a failed API probe (api_unreachable)
 * outranks any silence, since a block already explains the silence.
 */
export async function checkWhatsAppIntakeHealth(now: Date = new Date()): Promise<WhatsAppIntakeHealth> {
  const configured = Boolean(process.env.WHATSAPP_ACCESS_TOKEN?.trim()) && resolveConfiguredPhoneNumberIds().length > 0;
  if (!configured) {
    return {
      ...evaluateWhatsAppIntakeHealth({
        apiError: null,
        configured: false,
        lastInboundAt: null,
        now,
        silenceThresholdHours: silenceAlertHours(),
      }),
      probes: [],
    };
  }

  const threshold = silenceAlertHours();
  const [probes, lastInbound, routing] = await Promise.all([
    probeAllWhatsAppNumbers(),
    lastInboundWhatsAppAt().catch(() => null),
    fetchWebhookRouting(),
  ]);

  // Attach each line's own last-inbound (best-effort — a query failure just leaves it null/uncheckable).
  const enriched: WhatsAppNumberProbe[] = await Promise.all(
    probes.map(async (probe) => {
      const at = await lastInboundWhatsAppAtByNumber(probe.phoneNumberId).catch(() => null);
      return { ...probe, lastInboundAt: at ? at.toISOString() : null };
    }),
  );

  const core = evaluateWhatsAppIntakeHealth({
    apiError: aggregateProbeError(enriched),
    configured: true,
    lastInboundAt: lastInbound,
    now,
    routing,
    silenceThresholdHours: threshold,
  });

  // Per-number silence only escalates when the channel otherwise looks OK — a block/restriction is
  // already reported as api_unreachable, and the channel-wide "silent" already covers a total stop.
  if (core.status === "ok") {
    const silentLines = enriched.filter((probe) =>
      isNumberSilent({ lastInboundAt: probe.lastInboundAt ? new Date(probe.lastInboundAt) : null, now, ok: probe.ok, thresholdHours: threshold }),
    );
    if (silentLines.length > 0) {
      const labels = silentLines.map((probe) => probe.displayNumber ?? probe.phoneNumberId).join(", ");
      return {
        ...core,
        detail: `Line(s) ${labels} have gone quiet (>${threshold}h) while the API is healthy — check that line's webhook routing.`,
        probes: enriched,
        status: "silent",
      };
    }
  }

  return { ...core, probes: enriched };
}
