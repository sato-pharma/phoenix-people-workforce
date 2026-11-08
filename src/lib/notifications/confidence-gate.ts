import { systemEmail } from "@/config/system-settings";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { AccessContext } from "@/lib/auth/permissions";
import type { PreparedEmailAttachment } from "@/lib/email/email-providers";
import { ADMIN_STANDING_EMAIL } from "@/lib/email/admin-telegram-mirror";
import { conflictError } from "@/lib/http/api-errors";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { logError, logInfo } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// Notification Confidence Gate — every automated email in Phoenix passes through
// evaluateAndRecordNotificationSend() from send-phoenix-email.ts (the single choke point
// every automated email goes through, confirmed by tracing every call site — see PR
// description). Built after a 2026-07-23 incident: a newly-deployed "No Activity Recorded"
// notice mass-flagged 92 of 115 active employees off one thin day of attendance data, with
// no safeguard catching it before it fired. A failing check here HOLDS the send outright —
// it is never sent, and a Super Admin must approve or discard it from
// /admin/notification-confidence. A majority of passing checks never outvotes one failing
// one: this class of incident (mass false-positive) is exactly what must never slip through
// on points.
//
// RECALIBRATED 2026-08-28 after measuring five weeks of live behaviour: 679 held rows covering
// 174 unique emails plus 505 duplicate retries — and ZERO ever discarded. The gate had never once
// stopped a bad email, while blocking roughly half of all mail (66.8% held the week of
// 2026-08-10), stranding 114 recruitment notices, 37 resignation notices, and 6 people locked out
// of Phoenix behind undelivered password-reset and account-setup links for 27 days. Three
// concrete defects, each fixed below:
//
//  1. IT FED ITSELF. checkFanoutAnomaly counted rows in notification_send_reviews over the last
//     15 minutes — including rows written by RETRIES of already-held sends. A hold made the
//     sender retry, each retry wrote another row, and the fan-out counter read its own echo as
//     evidence of a bigger burst. 74% of the backlog was that echo: the same idempotency_key
//     appearing 4 to 8 times.
//  2. IT WAS THE WRONG DETECTOR. fanoutToBcc (send-phoenix-email.ts) collapses a genuine mass
//     send into ONE email carrying many BCC recipients, so the 2026-07-23 incident shape arrives
//     as a single send that checkFanoutAnomaly cannot see at all. What it flagged instead was
//     ordinary business volume — 17 resignations legitimately means 17 emails. It caused 654 of
//     679 holds (96%) and caught nothing. REMOVED. checkRecipientVolume is the check that
//     actually targets that incident shape, and it stays.
//  3. A HOLD LASTED FOREVER. The daily reminder fired correctly every day for 27 consecutive days
//     and was simply absorbed. A hold nobody ever decides is not a review, it is an undisclosed
//     deletion. expireStaleHeldNotifications() now closes every hold within HOLD_EXPIRY_HOURS and
//     announces the outcome.
//
// And a single-recipient send is never held at all: one person cannot be a mass send by
// definition, so transactional mail (password reset, account setup, one-employee workflow
// notices) can no longer be collateral damage of a volume check.

export type NotificationOrigin = {
  /** The one mailbox a person pressed for. Read by the Recipient Assurance Guard: see `chosenMailbox` there. */
  chosenMailbox?: string | null;
  employeeHrId?: string | null;
  eventType?: string | null;
  identityStatus?: string | null;
  module?: string | null;
  notificationType?: string | null;
  recipientHrId?: string | null;
  templateKey?: string | null;
};

export type ConfidenceCheck = {
  detail: string;
  name: string;
  // null = not applicable to this send (no penalty, no credit) — e.g. the fan-out check
  // when the caller didn't supply a module/eventType to group by.
  passed: boolean | null;
};

export type ConfidenceGateInput = {
  /**
   * Real people this send reaches, computed by the caller BEFORE fanoutToBcc and the standing
   * admin BCC rewrite the address arrays. Falls back to computeRealAudienceSize when absent.
   */
  audienceSize?: number;
  /** The files on the send. Kept only if the send is HELD, so approving it sends them too. */
  attachments?: PreparedEmailAttachment[];
  bcc?: string[];
  cc?: string[];
  /** The resolved sender. Kept only if the send is HELD, so approving it sends from the same address. */
  from?: string;
  html: string;
  idempotencyKey: string;
  origin?: NotificationOrigin | null;
  /** The resolved Reply-To. Kept only if the send is HELD, so replies to the approved email go where they would have. */
  replyTo?: string;
  subject: string;
  text: string;
  to: string[];
};

export type ConfidenceGateResult = {
  checks: ConfidenceCheck[];
  confidencePercent: number;
  decision: "auto_send" | "hold";
  reviewId: string | null;
};

export type NotificationSendReview = {
  bccAddresses: string[];
  ccAddresses: string[];
  checks: ConfidenceCheck[];
  confidencePercent: number;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  decision: "auto_send" | "hold";
  decisionNote: string | null;
  employeeHrId: string | null;
  eventType: string | null;
  gateBypassed: boolean;
  id: string;
  idempotencyKey: string;
  module: string | null;
  notificationType: string | null;
  providerMessageId: string | null;
  recipientHrId: string | null;
  renderedHtml: string;
  renderedText: string;
  status: "approved" | "auto_sent" | "discarded" | "held";
  subject: string;
  templateKey: string | null;
  toAddresses: string[];
};

type ReviewRow = {
  bcc_addresses: string[] | null;
  cc_addresses: string[] | null;
  checks: ConfidenceCheck[] | null;
  confidence_percent: number;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
  decision: "auto_send" | "hold";
  decision_note: string | null;
  employee_hr_id: string | null;
  event_type: string | null;
  gate_bypassed: boolean;
  id: string;
  idempotency_key: string;
  module: string | null;
  notification_type: string | null;
  provider_message_id: string | null;
  recipient_hr_id: string | null;
  rendered_html: string;
  rendered_text: string;
  status: "approved" | "auto_sent" | "discarded" | "held";
  subject: string;
  template_key: string | null;
  to_addresses: string[] | null;
};

const REVIEW_COLUMNS =
  "id,idempotency_key,module,event_type,notification_type,template_key,recipient_hr_id,employee_hr_id,to_addresses,cc_addresses,bcc_addresses,subject,rendered_html,rendered_text,checks,confidence_percent,decision,status,gate_bypassed,provider_message_id,decided_by,decided_at,decision_note,created_at";

function mapReviewRow(row: ReviewRow): NotificationSendReview {
  return {
    bccAddresses: row.bcc_addresses ?? [],
    ccAddresses: row.cc_addresses ?? [],
    checks: row.checks ?? [],
    confidencePercent: row.confidence_percent,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    decision: row.decision,
    decisionNote: row.decision_note,
    employeeHrId: row.employee_hr_id,
    eventType: row.event_type,
    gateBypassed: row.gate_bypassed,
    id: row.id,
    idempotencyKey: row.idempotency_key,
    module: row.module,
    notificationType: row.notification_type,
    providerMessageId: row.provider_message_id,
    recipientHrId: row.recipient_hr_id,
    renderedHtml: row.rendered_html,
    renderedText: row.rendered_text,
    status: row.status,
    subject: row.subject,
    templateKey: row.template_key,
    toAddresses: row.to_addresses ?? [],
  };
}

function gateEnabled() {
  // Emergency bypass: set NOTIFICATION_CONFIDENCE_GATE_ENABLED=false to stop the gate from
  // ever holding a send (e.g. if the gate itself misbehaves). Sends are still recorded for
  // audit — this only disables the "hold" decision, never the logging.
  const raw = String(process.env.NOTIFICATION_CONFIDENCE_GATE_ENABLED ?? "true").trim().toLowerCase();
  return raw !== "false" && raw !== "0" && raw !== "off";
}

const UNRESOLVED_TOKEN_PATTERN = /\{\{\s*[a-zA-Z0-9_]+\s*\}\}/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Exported for direct unit coverage (tests/notification-confidence-gate.test.ts) — these are
// pure, no I/O, unlike checkRecipientVolume and evaluateAndRecordNotificationSend, which both
// need Supabase.
export function checkContentIntegrity(input: ConfidenceGateInput): ConfidenceCheck {
  const empty = !input.subject.trim() || !input.html.trim() || !input.text.trim();
  const brokenToken = UNRESOLVED_TOKEN_PATTERN.test(input.subject) || UNRESOLVED_TOKEN_PATTERN.test(input.html) || UNRESOLVED_TOKEN_PATTERN.test(input.text);
  const passed = !empty && !brokenToken;
  return {
    detail: passed
      ? "Subject/body fully rendered — no unresolved {{token}}, no empty field."
      : empty
        ? "Subject, HTML body, or text body is empty."
        : "An unresolved {{token}} remains in the rendered content (the template render map is missing this field).",
    name: "content_integrity",
    passed,
  };
}

export function checkRecipientValidity(input: ConfidenceGateInput): ConfidenceCheck {
  const to = input.to.filter(Boolean);
  const passed = to.length > 0 && to.every((address) => EMAIL_PATTERN.test(address));
  return {
    detail: passed ? `${to.length} valid recipient address(es).` : "No recipient, or a recipient address failed basic format validation.",
    name: "recipient_validity",
    passed,
  };
}

// Only a genuine identity FAILURE may hold a send. resolvedEmailIdentity (system.ts) emits
// exactly three statuses: "failed" when the subject HR ID conflicts or is missing on a workflow
// email that requires one (it also sets a non-null identityError); "verified" when a subject HR
// ID resolved; and "not_required" when there simply is no subject employee and none is needed —
// the normal, healthy state for recruitment notices, digests and other non-employee-scoped mail.
//
// Treating "not_required" as a failure (the original `status === "verified"` test) held every one
// of those legitimate sends: confirmed in production, where the only two held rows scored 3/4 with
// the fan-out check PASSING and were blocked solely on `identity_resolved: not_required`. Because
// an omitted status already yields `passed: null`, that logic also punished callers for honestly
// reporting "not_required" while letting silent ones through — backwards. "not_required" is now
// not-applicable (no penalty, no credit), matching how this file treats every other inapplicable
// check.
export function checkIdentityResolved(input: ConfidenceGateInput): ConfidenceCheck {
  const status = input.origin?.identityStatus ?? null;
  if (!status) {
    return { detail: "No identity status supplied by the caller.", name: "identity_resolved", passed: null };
  }
  if (status === "not_required") {
    return {
      detail: "Recipient identity status: not_required (no subject employee is needed for this notification).",
      name: "identity_resolved",
      passed: null,
    };
  }
  return { detail: `Recipient identity status: ${status}.`, name: "identity_resolved", passed: status === "verified" };
}

const BASELINE_STDDEV_MULTIPLIER = 3;
const FIRST_RUN_MAX_ABSOLUTE = 10;
const FIRST_RUN_MAX_HEADCOUNT_FRACTION = 0.25;

/**
 * A send reaching at most this many real people can never be a mass-send incident, so it is never
 * held. "Real people" deliberately excludes the standing admin BCC and the neutral reply-to
 * placeholder that fanoutToBcc leaves in To — send-phoenix-email.ts attaches both to EVERY
 * message, which would otherwise make a one-person email look like a three-person one.
 */
const NEVER_HOLD_MAX_AUDIENCE = 1;

/** The audience the gate will judge: the caller's own count when supplied, else derived. */
export function resolveAudienceSize(input: { audienceSize?: number; bcc?: string[] | null; cc?: string[] | null; to?: string[] | null }): number {
  return input.audienceSize ?? computeRealAudienceSize(input);
}

/**
 * Whether this send is too small to be a mass-send incident, and so is never held on volume.
 *
 * Exported and pure specifically so the rule that protects transactional mail is proven by a unit
 * test rather than inferred from the gate's Supabase-bound path — this is the clause standing
 * between an employee and a password-reset link that never arrives, and it went 27 days unnoticed
 * once already.
 */
export function isExemptFromVolumeChecks(input: { audienceSize?: number; bcc?: string[] | null; cc?: string[] | null; to?: string[] | null }): boolean {
  return resolveAudienceSize(input) <= NEVER_HOLD_MAX_AUDIENCE;
}

/** Addresses the system attaches to every send, which are never part of the intended audience. */
function systemAttachedAddresses(): Set<string> {
  return new Set(
    [ADMIN_STANDING_EMAIL, process.env.NOTIFICATION_REPLY_TO || systemEmail.defaultReplyTo]
      .map((address) => String(address ?? "").trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * How many real people a send reaches. Pure and exported so the identical arithmetic applies to
 * the live send and to every historical row it is compared against — deriving it from the stored
 * to/cc/bcc arrays means no migration and no discontinuity in an established baseline.
 *
 * Correct on the POST-transform arrays the gate actually receives, which is why no change to
 * send-phoenix-email.ts is needed: a fanned-out send arrives as to=[reply-to placeholder] with
 * every real recipient in BCC, and the always-BCC block has added the standing admin — this strips
 * both back out, so a one-person email counts 1 and a two-hundred-person one counts 200.
 *
 * Known, deliberate imprecision: a caller passing its own `replyTo` leaves a placeholder this
 * function does not recognise, so such a fan-out counts one too many. Harmless — historical rows
 * carry the same shape, so an established baseline shifts with it, and the error is toward holding
 * rather than sending.
 */
export function computeRealAudienceSize(input: { bcc?: string[] | null; cc?: string[] | null; to?: string[] | null }): number {
  const attached = systemAttachedAddresses();
  const audience = new Set<string>();
  for (const address of [...(input.to ?? []), ...(input.cc ?? []), ...(input.bcc ?? [])]) {
    const normalized = String(address ?? "").trim().toLowerCase();
    if (!normalized || attached.has(normalized)) continue;
    audience.add(normalized);
  }
  return audience.size;
}

/**
 * The same count, taken from a stored notification_send_reviews row.
 *
 * Exists because the row is snake_case and computeRealAudienceSize takes to/cc/bcc: handing it the
 * row directly is a TS2559 "no properties in common", and had CI not caught that it would have
 * scored every historical row as 0 recipients at runtime — collapsing the baseline to zero, pinning
 * the ceiling at its bare floor of 3, and making the gate hold MORE mail rather than less. The
 * compiler now rejects the un-mapped form, and the test pins that the mapping reads the right
 * columns (a wrong-but-well-typed mapping, e.g. to: row.cc_addresses, would still compile).
 */
export function audienceSizeFromReviewRow(row: {
  bcc_addresses?: string[] | null;
  cc_addresses?: string[] | null;
  to_addresses?: string[] | null;
}): number {
  return computeRealAudienceSize({ bcc: row.bcc_addresses, cc: row.cc_addresses, to: row.to_addresses });
}

// Minimum number of PRIOR SENDS (not days — a recipient-count distribution is a per-send metric)
// of this (module,eventType) pair needed to trust a statistical baseline over the flat first-run
// ceiling.
const RECIPIENT_VOLUME_MIN_HISTORY_SENDS = 5;

export type CeilingOverride = {
  /**
   * When this override is consulted.
   *
   * `first_run` — only while the pair has no baseline of its own. Once it has real history, that
   * history is trusted over anything written here.
   *
   * `always` — also once the pair is established, and ONLY for a pair whose AUDIENCE DESIGN changed
   * after its history was measured. A baseline is a description of what the code used to do; when
   * the code deliberately starts addressing more people, the baseline is not evidence of an
   * incident, it is a record of the behaviour that was just fixed. Without this the gate holds every
   * send of the corrected notice until 5 sends older than 24 hours accumulate — weeks, for anything
   * that fires weekly — and a hold nobody clears is an undisclosed deletion (defect 3 above).
   */
  appliesTo: "always" | "first_run";
  /** The floor this pair's ceiling is raised to. Never lowers a computed ceiling. */
  ceiling: number;
};

/**
 * Per-(module,eventType) ceiling overrides — for a notification whose design already knows its own
 * real recipient count exceeds the generic 10-recipient first-run cap, so it does not have to sit on
 * hold every time until RECIPIENT_VOLUME_MIN_HISTORY_SENDS worth of real history accumulates. Only
 * ever RAISES the ceiling (Math.max with the computed one below). Keep this list short and each
 * entry justified; it is a deliberate, per-notification exception to the gate's general "no manual
 * carve-outs" posture, not a place to quietly raise the bar everywhere.
 */
export const CEILING_OVERRIDES: Record<string, CeilingOverride> = {
  // The market-awareness hand-off notice went to exactly ONE person for its whole life — the owner's
  // 2026-09-28 rule made it copy the requester, his manager and every approver, which is 4-10 people.
  // Its established baseline, measured live that day, was ~1.1 (±0.3) over 7 prior sends, giving a
  // ceiling of 3: the first refire held 3 of 4 notices at 67% and the owner had to clear them by hand
  // within the minute. `always`, not `first_run`, is the whole point — the pair IS established, and
  // what it is established on is the single-recipient bug. Requester + manager + up to four approver
  // slots + the CEO is ten by design; 12 is that with room for a slot being added, not a blank cheque.
  "market_awareness/market_awareness_decision_pending": { appliesTo: "always", ceiling: 12 },
  // The CEO-approval announcement: three execution roles on the To line (NSM, SFE Manager, Finance)
  // plus the same copied workflow. No history at all yet, so first_run is enough — once it has its
  // own baseline, that baseline will already describe the copied shape.
  "market_awareness/market_awareness_activity_approved": { appliesTo: "first_run", ceiling: 12 },
  // Anti Infective/Pedia/CNS Monthly Closing publish: until 2026-10-10 it notified that line's District
  // Managers plus a fixed Cc/Bcc roster (CEO, Marketing Manager, SFE Manager, the line's NSM and Product
  // Manager, two named individuals) — 10-15 recipients, 12 on Anti Infective's first send 2026-08-08.
  // 2026-10-10: the audience grew from a line's District Managers to EVERYONE seated on it (owner: "goes to
  // all in the published line") — about 34 people a line plus the Cc roster, so a 60 ceiling. `always`,
  // because the pair already has a baseline from the old 12-recipient shape, which is exactly the
  // behaviour that was just changed; without it the first publish after this lands is held.
  "sales/closing_published": { appliesTo: "always", ceiling: 60 },
  // A job offer went to exactly ONE person — the candidate — until the owner asked for CC and BCC on
  // 2026-09-28. Its baseline therefore reads ~1, ceiling 3, and would hold every offer copied to three
  // or more people: an offer letter sitting in a review queue while a candidate waits. `always`, for
  // the same reason as the market-awareness entry — the audience DESIGN changed, so the old baseline
  // describes the one-recipient shape, not an incident. 11 is the candidate plus OFFER_COPY_MAX (10)
  // copies; the send refuses more than that itself, so this ceiling can never be the thing that stops
  // one. Pinned to OFFER_COPY_MAX by tests/offer-copy-recipients.test.ts.
  "offers/offer_letter": { appliesTo: "always", ceiling: 11 },
  // The Marketing Manager's "Approved requests" email (owner, 2026-11-08): To Finance (2), Cc every
  // requester in it, each one's managers up to the National Sales Manager, Dr Anwar, Omar Anwar and the
  // sender — about 20 people for a week, by design. A brand-new pair would otherwise be capped at 10 and
  // his first send would sit in a review queue. 60 is APPROVED_REQUESTS_MAX_RECIPIENTS: the send refuses
  // more than that itself, so this ceiling is never the thing that stops one.
  "marketing_requests/approved_requests_sent": { appliesTo: "always", ceiling: 60 },
};

/**
 * The ceiling floor that applies to this pair, or undefined when none does.
 *
 * Pure and exported so the `always` vs `first_run` distinction is proven by a unit test rather than
 * inferred from the gate's Supabase-bound path — an entry silently reverting to first_run-only would
 * put every market-awareness notice back in the hold queue, which is invisible until somebody
 * notices a queue nobody is clearing.
 */
export function resolveCeilingOverride(
  moduleName: string,
  eventType: string,
  basis: "established" | "first_run",
): number | undefined {
  const configured = CEILING_OVERRIDES[`${moduleName}/${eventType}`];
  if (!configured) return undefined;
  if (configured.appliesTo === "always" || basis === "first_run") return configured.ceiling;
  return undefined;
}

/**
 * Pure decision math for checkRecipientVolume, split out so it is unit-testable without Supabase:
 * its caller has to query prior sends, this function deliberately does not.
 */
export function computeRecipientVolumeCeiling(
  priorCounts: number[],
  headcount: number,
): { basis: "established" | "first_run"; ceiling: number; mean?: number; stddev?: number } {
  if (priorCounts.length >= RECIPIENT_VOLUME_MIN_HISTORY_SENDS) {
    const mean = priorCounts.reduce((sum, value) => sum + value, 0) / priorCounts.length;
    const variance = priorCounts.reduce((sum, value) => sum + (value - mean) ** 2, 0) / priorCounts.length;
    const stddev = Math.sqrt(variance);
    return { basis: "established", ceiling: Math.max(mean + BASELINE_STDDEV_MULTIPLIER * stddev, mean * 2, 3), mean, stddev };
  }
  const ceiling = Math.max(3, Math.min(FIRST_RUN_MAX_ABSOLUTE, Math.round(headcount * FIRST_RUN_MAX_HEADCOUNT_FRACTION)));
  return { basis: "first_run", ceiling };
}

/**
 * THE mass-send check, and since the 2026-08-28 recalibration the only one. It judges a SINGLE
 * send with an unusually large recipient list — exactly the shape a real incident takes here,
 * because fanoutToBcc (send-phoenix-email.ts) deliberately collapses many recipients into one
 * email (all but the primary go to BCC). That collapsing is precisely why the old per-15-minute
 * fan-out counter could never see the thing this gate exists to stop: a single mis-scoped policy
 * (e.g. "general" recipientMode "selected_titles_all_lines" with targetTitles: ["Medical
 * Representative"], loadEmployeesByTitlesAndLines returning every matching employee unbounded)
 * reaches hundreds of people in ONE send, which that counter read as a burst of exactly 1 and
 * waved through. checkRecipientValidity only inspects `to` (length 1, since the rest are BCC'd),
 * so it passes too. Before this check, that path was "Company-wide email, no cap, no hold, no
 * confirmation" — found auditing the gate, not from a live incident, but it is the same shape as
 * the 2026-07-23 incident this gate exists to catch.
 *
 * Two modes, over recipient COUNT PER SEND: an established (module,eventType) pair is judged
 * against its own historical per-send recipient-count baseline (so a routinely-large distribution
 * list, e.g. a company-wide holiday announcement, never trips this once it has a track record); a
 * brand-new or rare pair gets a flat first-run ceiling instead. Fails OPEN on infra error, matching
 * this file's philosophy — a transient DB hiccup must never become a second, self-inflicted outage.
 * A single-recipient send never reaches this check at all; see evaluateAndRecordNotificationSend.
 */
async function checkRecipientVolume(input: ConfidenceGateInput): Promise<ConfidenceCheck> {
  const moduleName = input.origin?.module ?? null;
  const eventType = input.origin?.eventType ?? null;
  if (!moduleName || !eventType) {
    return { detail: "No module/eventType supplied by the caller.", name: "recipient_volume", passed: null };
  }
  const currentRecipientCount = input.audienceSize ?? computeRealAudienceSize(input);
  try {
    const supabase = getSupabaseAdmin();
    // Only sends that ACTUALLY WENT OUT form the baseline, and each logical email counts once.
    // Held rows are excluded deliberately: a hold makes the sender retry, every retry writes
    // another review row, and counting those let the gate build a baseline out of its own echo
    // (defect 1 in the file header — 505 of the 679 backlog rows were exactly that).
    const { data: priorRows, error: priorError } = await supabase
      .from("notification_send_reviews")
      .select("idempotency_key, to_addresses, cc_addresses, bcc_addresses")
      .eq("module", moduleName)
      .eq("event_type", eventType)
      .in("status", ["auto_sent", "approved"])
      .lt("created_at", new Date(Date.now() - 24 * 60 * 60_000).toISOString())
      .gte("created_at", new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString())
      .limit(500);
    if (priorError) throw priorError;

    const countByKey = new Map<string, number>();
    for (const row of (priorRows ?? []) as Array<{
      bcc_addresses: string[] | null;
      cc_addresses: string[] | null;
      idempotency_key: string | null;
      to_addresses: string[] | null;
    }>) {
      const key = row.idempotency_key ?? `row-${countByKey.size}`;
      if (countByKey.has(key)) continue;
      countByKey.set(key, audienceSizeFromReviewRow(row));
    }
    const priorCounts = Array.from(countByKey.values());

    const employees = await getEmployeeDirectoryRows().catch(() => []);
    const headcount = employees.length || 1;
    const { basis, ceiling: computedCeiling, mean, stddev } = computeRecipientVolumeCeiling(priorCounts, headcount);
    const override = resolveCeilingOverride(moduleName, eventType, basis);
    const ceiling = override !== undefined ? Math.max(computedCeiling, override) : computedCeiling;
    const passed = currentRecipientCount <= ceiling;
    const detail =
      basis === "established"
        ? override !== undefined
          ? `${currentRecipientCount} recipient(s) on this send vs an established baseline of ~${(mean ?? 0).toFixed(1)} (±${(stddev ?? 0).toFixed(1)} stddev) over ${priorCounts.length} prior sends of "${moduleName}/${eventType}" — judged against a known-design ceiling of ${ceiling} instead, because this notice's audience changed after that baseline was measured.`
          : `${currentRecipientCount} recipient(s) on this send vs an established baseline of ~${(mean ?? 0).toFixed(1)} (±${(stddev ?? 0).toFixed(1)} stddev) over ${priorCounts.length} prior sends of "${moduleName}/${eventType}".`
        : override !== undefined
          ? `${currentRecipientCount} recipient(s) on this send for "${moduleName}/${eventType}" — no established history yet, but a known-design ceiling of ${ceiling} applies instead of the generic first-run cap.`
          : `${currentRecipientCount} recipient(s) on this send for "${moduleName}/${eventType}", which has no established history yet — capped at ${ceiling} while it's new.`;
    return { detail, name: "recipient_volume", passed };
  } catch (error) {
    logError("Confidence gate recipient-volume check failed — defaulting to pass (fail-open on infra error)", {
      error,
      labels: { event: "confidence_gate_recipient_volume_check_failed", eventType, module: moduleName },
    });
    return { detail: "Recipient-volume check could not run (infra error) — defaulted to pass.", name: "recipient_volume", passed: true };
  }
}

export function computeDecision(checks: ConfidenceCheck[]): { confidencePercent: number; decision: "auto_send" | "hold" } {
  const applicable = checks.filter((check) => check.passed !== null);
  const failed = applicable.filter((check) => check.passed === false);
  const confidencePercent = applicable.length === 0
    ? 100
    : Math.round((applicable.filter((check) => check.passed === true).length / applicable.length) * 100);
  // One failing check holds the send outright — a majority of green checks never outvotes a
  // single red one. Averaging-to-a-threshold would have let this exact incident's fan-out
  // failure get diluted by three unrelated passing checks.
  return { confidencePercent, decision: failed.length > 0 ? "hold" : "auto_send" };
}

/** Called from send-phoenix-email.ts immediately before every real dispatch attempt. */
export async function evaluateAndRecordNotificationSend(input: ConfidenceGateInput): Promise<ConfidenceGateResult> {
  const enabled = gateEnabled();
  // One person is not a mass send. Every volume check exists to catch mail reaching far more
  // people than intended; none of them can meaningfully judge an audience of one, and running
  // them anyway is what stranded 6 employees behind undelivered password-reset and account-setup
  // links for 27 days. Content and recipient-validity checks still apply in full.
  const audienceSize = resolveAudienceSize(input);
  const singleRecipient = isExemptFromVolumeChecks(input);
  const checks: ConfidenceCheck[] = [
    checkContentIntegrity(input),
    checkRecipientValidity(input),
    checkIdentityResolved(input),
    singleRecipient
      ? {
          detail: `Reaches ${audienceSize} real recipient — a single-recipient send cannot be a mass-send incident, so volume checks do not apply.`,
          name: "recipient_volume",
          passed: null,
        }
      : await checkRecipientVolume(input),
  ];
  const computed = computeDecision(checks);
  let decision = computed.decision;
  const confidencePercent = computed.confidencePercent;
  if (!enabled && decision === "hold") {
    checks.push({ detail: "NOTIFICATION_CONFIDENCE_GATE_ENABLED=false — gate bypassed, this would otherwise have been held.", name: "gate_enabled", passed: null });
    decision = "auto_send";
  }

  let reviewId: string | null = null;
  try {
    // A held send keeps its files, or approving it would send the email without them. Only a hold
    // writes them; a send that goes out now has no later re-send to feed.
    const heldAttachments =
      decision === "hold" && input.attachments && input.attachments.length > 0
        ? await keepHeldAttachments(input.attachments, getSupabaseAdmin())
        : null;
    const { data, error } = await getSupabaseAdmin()
      .from("notification_send_reviews")
      .insert({
        ...(heldAttachments ? { held_attachments: heldAttachments } : {}),
        // The sender and Reply-To the send resolved, or approving it would send from the default
        // address and route replies to the default inbox. Hold-only, like the files.
        ...(decision === "hold" && input.from ? { held_from_address: input.from } : {}),
        ...(decision === "hold" && input.replyTo ? { held_reply_to_address: input.replyTo } : {}),
        bcc_addresses: input.bcc ?? [],
        cc_addresses: input.cc ?? [],
        checks,
        confidence_percent: confidencePercent,
        decision,
        employee_hr_id: input.origin?.employeeHrId ?? null,
        event_type: input.origin?.eventType ?? null,
        gate_bypassed: !enabled,
        idempotency_key: input.idempotencyKey,
        module: input.origin?.module ?? null,
        notification_type: input.origin?.notificationType ?? null,
        recipient_hr_id: input.origin?.recipientHrId ?? null,
        rendered_html: input.html,
        rendered_text: input.text,
        status: decision === "hold" ? "held" : "auto_sent",
        subject: input.subject,
        template_key: input.origin?.templateKey ?? null,
        to_addresses: input.to,
      })
      .select("id")
      .single();
    if (error) throw error;
    reviewId = (data as { id: string }).id;
  } catch (error) {
    // Never let an audit-logging failure block or hold an otherwise-legitimate send.
    logError("Confidence gate failed to persist send review — proceeding without a durable record", {
      error,
      labels: { event: "confidence_gate_persist_failed" },
    });
    decision = "auto_send";
  }

  if (decision === "hold") {
    logInfo(`Notification held for review: ${input.origin?.module ?? "unknown"}/${input.origin?.eventType ?? "unknown"} (${confidencePercent}% confidence)`, {
      labels: { event: "confidence_gate_held", eventType: input.origin?.eventType ?? "", module: input.origin?.module ?? "", reviewId: reviewId ?? "" },
    });
    // Tell a Super Admin the mail is sitting undelivered. A log line alone left two real
    // recruitment emails unnoticed for ~22 hours on 2026-07-24. In-app + Telegram only (never
    // email — that would re-enter this gate); throttled to one alert per module/eventType per hour
    // so a mass-hold burst cannot bury the signal. Lazy import: this module is imported BY
    // send-phoenix-email.ts at module scope, and the alert reaches system.ts → email.ts →
    // send-phoenix-email.ts, so a top-level import here would close that cycle (same reason
    // approveHeldNotification imports sendPhoenixEmail lazily below). Awaited but never throwing.
    try {
      const { notifyNotificationHeld } = await import("@/lib/notifications/held-notification-alert");
      await notifyNotificationHeld({
        confidencePercent,
        eventType: input.origin?.eventType ?? null,
        failedCheckNames: checks.filter((check) => check.passed === false).map((check) => check.name),
        module: input.origin?.module ?? null,
        reviewId,
        subject: input.subject,
      });
    } catch (error) {
      logError("Held-notification alert could not be dispatched — the hold itself still stands", {
        error,
        labels: { event: "confidence_gate_held_alert_failed", reviewId: reviewId ?? "" },
      });
    }
  }

  return { checks, confidencePercent, decision, reviewId };
}

/** Best-effort: attach the provider's message id to the review row once a send succeeds. */
export async function markNotificationSendDelivered(reviewId: string | null, providerMessageId: string | undefined) {
  if (!reviewId) return;
  try {
    await getSupabaseAdmin()
      .from("notification_send_reviews")
      .update({ provider_message_id: providerMessageId ?? null, updated_at: new Date().toISOString() })
      .eq("id", reviewId);
  } catch (error) {
    logError("Confidence gate failed to record delivered provider id", { error, labels: { event: "confidence_gate_mark_delivered_failed", reviewId } });
  }
}

function assertConfidenceGateActor(access: Pick<AccessContext, "role">) {
  if (access.role !== "Super Admin") {
    throw new Error("Forbidden: only Super Admin can review held notifications.");
  }
}

export async function listRecentNotificationSends(access: AccessContext, input: { limit?: number } = {}): Promise<NotificationSendReview[]> {
  assertConfidenceGateActor(access);
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const { data, error } = await getSupabaseAdmin()
    .from("notification_send_reviews")
    .select(REVIEW_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as ReviewRow[]).map(mapReviewRow);
}

export async function listPendingNotificationReviews(access: AccessContext): Promise<NotificationSendReview[]> {
  assertConfidenceGateActor(access);
  const { data, error } = await getSupabaseAdmin()
    .from("notification_send_reviews")
    .select(REVIEW_COLUMNS)
    .eq("status", "held")
    .order("created_at", { ascending: true })
    .limit(300);
  if (error) throw error;
  return ((data ?? []) as ReviewRow[]).map(mapReviewRow);
}

export async function discardHeldNotification(access: AccessContext, reviewId: string, note?: string) {
  assertConfidenceGateActor(access);
  const decidedBy = access.hrId ?? access.loginId ?? "system";
  const { data, error } = await getSupabaseAdmin()
    .from("notification_send_reviews")
    .update({
      decided_at: new Date().toISOString(),
      decided_by: decidedBy,
      decision_note: note?.trim() || null,
      status: "discarded",
      updated_at: new Date().toISOString(),
    })
    .eq("id", reviewId)
    .eq("status", "held")
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw conflictError("This item is no longer pending review (already decided, or not found).");
}

/**
 * A Super Admin manually approving a held item — sends the EXACT content that was rendered
 * at hold time (never re-rendered, so what the admin reviewed is what goes out), bypassing
 * the gate for this one already-reviewed send. Dynamic import: confidence-gate.ts is imported
 * BY send-phoenix-email.ts at module scope, so this side stays a lazy, function-scoped import
 * to keep the cycle safe (same pattern already used elsewhere in this codebase for a
 * table-builder cycle between email-templates/service.ts and a domain module).
 */
export async function approveHeldNotification(access: AccessContext, reviewId: string, note?: string) {
  assertConfidenceGateActor(access);
  const decidedBy = access.hrId ?? access.loginId ?? "system";
  const { data: row, error: fetchError } = await getSupabaseAdmin()
    .from("notification_send_reviews")
    .select(`${REVIEW_COLUMNS},held_attachments,held_from_address,held_reply_to_address`)
    .eq("id", reviewId)
    .eq("status", "held")
    .maybeSingle();
  if (fetchError) throw fetchError;
  if (!row) throw conflictError("This item is no longer pending review (already decided, or not found).");
  const held = mapReviewRow(row as ReviewRow);
  const kept = row as { held_attachments?: unknown; held_from_address?: string | null; held_reply_to_address?: string | null };
  // Read before the send: a file that cannot be read back refuses the approval, never drops off it.
  const attachments = await loadHeldAttachments(kept.held_attachments, getSupabaseAdmin());

  const { sendPhoenixEmail } = await import("@/lib/email/send-phoenix-email");
  const result = await sendPhoenixEmail({
    attachments,
    bcc: held.bccAddresses,
    bypassConfidenceGate: true,
    cc: held.ccAddresses,
    // A row held before these were kept has neither, and falls back to the defaults as it always did.
    from: kept.held_from_address || undefined,
    html: held.renderedHtml,
    idempotencyKey: `${held.idempotencyKey}:approved`,
    replyTo: kept.held_reply_to_address || undefined,
    subject: held.subject,
    text: held.renderedText,
    to: held.toAddresses,
  });
  if ("skipped" in result && result.skipped) {
    throw new Error(`Approved, but the send still failed: ${result.reason}`);
  }

  const { error: updateError } = await getSupabaseAdmin()
    .from("notification_send_reviews")
    .update({
      decided_at: new Date().toISOString(),
      decided_by: decidedBy,
      decision_note: note?.trim() || null,
      provider_message_id: "id" in result ? (result.id ?? null) : null,
      status: "approved",
      updated_at: new Date().toISOString(),
    })
    .eq("id", reviewId);
  if (updateError) throw updateError;
}

export const HELD_ATTACHMENTS_BUCKET = "notification-held-attachments";

/** One file of a held send, as the review row records it. `storagePath` null = it could not be kept. */
export type HeldAttachment = {
  byteSize: number;
  contentId?: string;
  contentType?: string;
  filename: string;
  remoteUrl?: string;
  storagePath: string | null;
};

/**
 * Stores a held send's files so approving it can send them. Never throws — a hold must stand even
 * when storage is down — so a file that could not be stored is recorded with `storagePath: null`,
 * and loadHeldAttachments refuses the approval over it instead of sending without it.
 */
export async function keepHeldAttachments(attachments: PreparedEmailAttachment[], supabase: SupabaseClient): Promise<HeldAttachment[]> {
  const folder = crypto.randomUUID();
  const kept: HeldAttachment[] = [];
  for (const [index, att] of attachments.entries()) {
    const bytes = Buffer.from(att.content, "base64");
    const entry: HeldAttachment = {
      byteSize: bytes.length,
      contentId: att.contentId,
      contentType: att.contentType,
      filename: att.filename,
      remoteUrl: att.remoteUrl,
      storagePath: null,
    };
    // The index keeps two files of the same name apart; the name never builds the path.
    const path = `${folder}/${index}`;
    try {
      const { error } = await supabase.storage.from(HELD_ATTACHMENTS_BUCKET).upload(path, bytes, {
        contentType: att.contentType || "application/octet-stream",
        upsert: false,
      });
      if (error) throw error;
      entry.storagePath = path;
    } catch (error) {
      logError("A held email's attachment could not be kept — approving it will be refused rather than send without the file", {
        error,
        labels: { event: "confidence_gate_held_attachment_keep_failed" },
      });
    }
    kept.push(entry);
  }
  return kept;
}

/**
 * Reads a held send's files back for its approval. Any file that was not kept or cannot be read
 * REFUSES the approval: an approved email that arrives without its file is the defect this exists
 * to stop. Nothing recorded (a send that never had files) is undefined.
 */
export async function loadHeldAttachments(stored: unknown, supabase: SupabaseClient): Promise<PreparedEmailAttachment[] | undefined> {
  if (!Array.isArray(stored) || stored.length === 0) return undefined;
  const loaded: PreparedEmailAttachment[] = [];
  for (const raw of stored as HeldAttachment[]) {
    const name = raw?.filename || "an attachment";
    const refusal = conflictError(
      `"${name}" could not be kept when this email was held, so approving it would send the email without the file. Discard it and send it again.`,
    );
    if (!raw?.storagePath) throw refusal;
    const { data, error } = await supabase.storage.from(HELD_ATTACHMENTS_BUCKET).download(raw.storagePath);
    if (error || !data) throw refusal;
    loaded.push({
      content: Buffer.from(await data.arrayBuffer()).toString("base64"),
      contentId: raw.contentId,
      contentType: raw.contentType,
      filename: raw.filename,
      remoteUrl: raw.remoteUrl,
    });
  }
  return loaded;
}

/**
 * Hours a held notification may sit before it is closed automatically. A hold is only a safety
 * mechanism if it reaches a decision: before this existed, the daily reminder fired correctly for
 * 27 consecutive days while 174 real emails stayed undelivered and the oldest reached 35 days
 * (defect 3 in the file header). An unreviewed hold is an undisclosed deletion — this makes the
 * deletion explicit, recorded, and announced.
 */
export const HOLD_EXPIRY_HOURS = 24;

/**
 * Holds created before this instant are the pre-recalibration backlog (679 rows on 2026-08-28,
 * 74% of them duplicate retries of 174 real emails). They are DELIBERATELY out of scope. Bulk
 * auto-resolving them would either fire hundreds of duplicates — a third bulk-email incident,
 * self-inflicted — or silently bury 174 real emails, including resignation notices sent that
 * morning. That backlog gets a deduplicated, owner-approved decision of its own. This sweep only
 * ever governs holds created under the recalibrated rules above, where a hold is rare and
 * genuinely means "this send reaches an unusually large audience".
 */
export const HOLD_EXPIRY_EFFECTIVE_FROM = "2026-08-28T00:00:00.000Z";

export type HoldExpiryResult = { expired: number; reason?: string; skipped: boolean };

/**
 * Closes every hold older than HOLD_EXPIRY_HOURS by DISCARDING it, and says so.
 *
 * Discard rather than send is the safe direction: after the recalibration above, the only thing
 * that can still be held is a send whose audience is far larger than that notification's own
 * history — precisely the shape nobody should release unreviewed. Best-effort by contract, never
 * throws: a sweep failure must not become a second incident.
 */
export async function expireStaleHeldNotifications(): Promise<HoldExpiryResult> {
  try {
    const cutoff = new Date(Date.now() - HOLD_EXPIRY_HOURS * 60 * 60_000).toISOString();
    const { data, error } = await getSupabaseAdmin()
      .from("notification_send_reviews")
      .update({
        decided_at: new Date().toISOString(),
        decided_by: "confidence-gate-expiry",
        decision_note: `Auto-discarded: held longer than ${HOLD_EXPIRY_HOURS}h with no Super Admin decision.`,
        status: "discarded",
        updated_at: new Date().toISOString(),
      })
      .eq("status", "held")
      .lt("created_at", cutoff)
      .gte("created_at", HOLD_EXPIRY_EFFECTIVE_FROM)
      .select("id, module, event_type, subject");
    if (error) throw error;

    const rows = (data ?? []) as Array<{ event_type: string | null; module: string | null; subject: string }>;
    if (rows.length === 0) return { expired: 0, reason: "nothing to expire", skipped: true };

    logInfo(`Confidence gate auto-discarded ${rows.length} notification(s) held beyond ${HOLD_EXPIRY_HOURS}h`, {
      labels: { count: String(rows.length), event: "confidence_gate_holds_expired" },
    });

    // Announced, never silent — the entire point of the deadline is that its outcome is visible.
    try {
      const { notifyExpiredNotifications } = await import("@/lib/notifications/held-notification-alert");
      await notifyExpiredNotifications({
        expiredCount: rows.length,
        sources: Array.from(new Set(rows.map((row) => `${row.module ?? "unknown"}/${row.event_type ?? "unknown"}`))).slice(0, 6),
      });
    } catch (alertError) {
      logError("Hold-expiry alert could not be dispatched — the expiry itself still stands", {
        error: alertError,
        labels: { event: "confidence_gate_expiry_alert_failed" },
      });
    }

    return { expired: rows.length, skipped: false };
  } catch (error) {
    logError("Confidence gate hold-expiry sweep failed", { error, labels: { event: "confidence_gate_expiry_failed" } });
    return { expired: 0, reason: error instanceof Error ? error.message : "unknown error", skipped: true };
  }
}
