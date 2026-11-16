// THE REASON LIST — how an employee explains a day the system shows as missing or charged.
//
// Owner, 2026-11-16: a calendar or deduction dispute used to arrive as free text ("something is
// wrong", "Manager Confirmation") that told the reviewer nothing, while the system itself was right —
// the day really had no record. His words: "find a more professional, easier, accurate way". So the
// employee no longer says the calendar is WRONG; he EXPLAINS the day, from a short list, and names who
// can confirm it:
//
//   - Training      — confirmed by his manager or the Training Manager who ran it.
//   - Meeting       — confirmed by his manager.
//   - Double visit  — confirmed by his manager.
//   - Something else — no confirmer; at least 25 characters and 4 words, straight to the Super Admin.
//
// "Fingerprint or device problem" was REMOVED by the owner (same day) — a device fault is not the
// employee's to declare. A day that was really LEAVE is not explained at all: the form sends him to the
// leave request instead, which HR approves and which charges his balance. An unlogged visit is not a
// reason either (owner): Phoenix CRM stays the only proof of a visit; "Something else" is still open.
//
// An explanation covers the missing part of the day, whole: on a half-day charge that is the missing
// half, exactly as an accepted request has spared a half-day charge since 13 Nov 2026. There is no
// "morning only" choice — it would have needed the full-day charges re-priced to half a day. (The
// `day_part` columns the migration added stay at their default 'whole'; nothing writes them.)
//
// The manager answers first, then the Super Admin decides (owner: "manager first then me"). A day can
// be explained until that day's payroll month is confirmed (owner: "Until payroll closes"); after that
// it goes through "ask for another look" on the decided case.
//
// Pure and client-safe: the employee's form, the server and the tests all read this one list.

export type ExplainReasonCode = "training" | "meeting" | "double_visit" | "other";

export const EXPLAIN_REASON_CODES: readonly ExplainReasonCode[] = ["training", "meeting", "double_visit", "other"];

/** Which module the explained case lives in (a subset of the Dispute Center's case kinds). */
export type ExplainCaseKind = "calendar" | "deduction" | "daily";

/**
 * Where the confirmer's answer stands:
 *  - not_needed — "Something else": nobody confirms, the Super Admin reads it directly.
 *  - awaiting   — the named confirmer has not answered yet.
 *  - confirmed  — the confirmer said it happened.
 *  - declined   — the confirmer said it did not (the Super Admin still decides).
 */
export type ExplainConfirmationStatus = "not_needed" | "awaiting" | "confirmed" | "declined";

/** One saved explanation, as every screen reads it (one per dispute case). */
export type DisputeExplanation = {
  id: string;
  caseKind: ExplainCaseKind;
  caseRef: string;
  groupId: string;
  employeeHrId: string;
  employeeName: string | null;
  reasonCode: ExplainReasonCode;
  detailText: string;
  dates: string[];
  confirmerHrId: string | null;
  confirmerName: string | null;
  confirmationStatus: ExplainConfirmationStatus;
  confirmationNote: string | null;
  confirmedAt: string | null;
  createdAt: string;
};

/** Who may be named as the confirmer for a reason. */
export type ExplainConfirmerKind = "manager" | "training_manager";

export type ExplainReason = {
  code: ExplainReasonCode;
  /** The words on the radio button. */
  label: string;
  /** The line under it, saying when to pick it. */
  hint: string;
  /** Who may confirm it. Empty: nobody confirms ("Something else"). */
  confirmerKinds: readonly ExplainConfirmerKind[];
};

export const EXPLAIN_REASONS: readonly ExplainReason[] = [
  {
    code: "training",
    confirmerKinds: ["manager", "training_manager"],
    hint: "You were in a training session. Your manager or the Training Manager who ran it confirms.",
    label: "Training",
  },
  {
    code: "meeting",
    confirmerKinds: ["manager"],
    hint: "You were in a meeting your manager called or attended. Your manager confirms.",
    label: "Meeting",
  },
  {
    code: "double_visit",
    confirmerKinds: ["manager"],
    hint: "You were in the field with your manager on a double visit. Your manager confirms.",
    label: "Double visit",
  },
  {
    code: "other",
    confirmerKinds: [],
    hint: "Anything else. Explain it in your own words; the Super Admin reads it directly.",
    label: "Something else",
  },
];

export const EXPLAIN_CONFIRMATION_LABELS: Record<ExplainConfirmationStatus, string> = {
  awaiting: "Waiting for confirmation",
  confirmed: "Confirmed",
  declined: "Not confirmed",
  not_needed: "No confirmer",
};

/** The leave request page — a day that was really leave is requested there, never explained here. */
export const EXPLAIN_LEAVE_REDIRECT_HREF = "/employee-portals/vacation-request";

/** "Something else" must say this much. */
export const EXPLAIN_OTHER_MIN_CHARS = 25;
export const EXPLAIN_OTHER_MIN_WORDS = 4;
/** Any explanation's own words stop here. */
export const EXPLAIN_DETAIL_MAX_CHARS = 1000;
/** One explanation may cover this many days at most (a training week, a run of meetings). */
export const EXPLAIN_MAX_DAYS = 14;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isExplainReasonCode(value: unknown): value is ExplainReasonCode {
  return typeof value === "string" && (EXPLAIN_REASON_CODES as readonly string[]).includes(value);
}

export function explainReason(code: ExplainReasonCode): ExplainReason {
  const reason = EXPLAIN_REASONS.find((entry) => entry.code === code);
  if (!reason) throw new Error(`Unknown reason "${code}".`);
  return reason;
}

/** Whether a reason needs a named confirmer. */
export function reasonNeedsConfirmer(code: ExplainReasonCode): boolean {
  return explainReason(code).confirmerKinds.length > 0;
}

function isRealIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map((part) => Number.parseInt(part, 10));
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

function addDaysIso(iso: string, days: number): string {
  const [year, month, day] = iso.split("-").map((part) => Number.parseInt(part, 10));
  const next = new Date(Date.UTC(year, month - 1, day + days));
  return next.toISOString().slice(0, 10);
}

/**
 * Every date from `from` to `to`, both included, in order. Date-only arithmetic in UTC, never through a
 * zone. Refuses a backwards range or one longer than {@link EXPLAIN_MAX_DAYS}.
 */
export function expandDateRange(from: string, to: string): string[] {
  if (!isRealIsoDate(from) || !isRealIsoDate(to)) throw new Error("Pick a real date.");
  if (to < from) throw new Error("The last day is before the first day.");
  const dates: string[] = [];
  let cursor = from;
  while (cursor <= to) {
    dates.push(cursor);
    if (dates.length > EXPLAIN_MAX_DAYS) {
      throw new Error(`One explanation covers ${EXPLAIN_MAX_DAYS} days at most.`);
    }
    cursor = addDaysIso(cursor, 1);
  }
  return dates;
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

export type ExplanationInput = {
  reasonCode: unknown;
  detailText?: unknown;
  dates: unknown;
  confirmerHrId?: unknown;
};

export type ValidExplanation = {
  reasonCode: ExplainReasonCode;
  detailText: string;
  dates: string[];
  confirmerHrId: string | null;
};

/**
 * Checks an explanation and returns it tidied, or throws one plain sentence the employee can act on.
 * `todayIso` is Cairo's today, passed in (no clock here). It checks only what the words and dates
 * themselves say; whether the confirmer is one of HIS managers, and whether each day's payroll month is
 * still open, are the server's to check.
 */
export function validateExplanation(input: ExplanationInput, todayIso: string): ValidExplanation {
  const reason = validateExplanationReason(input);
  if (!Array.isArray(input.dates) || input.dates.length === 0) throw new Error("Choose at least one day.");
  const unique = [...new Set(input.dates.map((value) => String(value ?? "").trim()))].sort();
  if (unique.length > EXPLAIN_MAX_DAYS) throw new Error(`One explanation covers ${EXPLAIN_MAX_DAYS} days at most.`);
  for (const date of unique) {
    if (!isRealIsoDate(date)) throw new Error("Pick a real date.");
    if (date > todayIso) throw new Error("A day that has not happened yet cannot be explained.");
  }
  return { ...reason, dates: unique };
}

/**
 * The reason, the words and the confirmer — the part every dispute shares. A deduction dispute uses
 * this alone: its days are the deduction's own, fixed by HR, never picked by the employee, so neither
 * the 14-day cap nor the date checks apply to them.
 */
export function validateExplanationReason(input: Omit<ExplanationInput, "dates">): Omit<ValidExplanation, "dates"> {
  if (!isExplainReasonCode(input.reasonCode)) throw new Error("Choose a reason from the list.");
  const reasonCode = input.reasonCode;
  const reason = explainReason(reasonCode);

  const detailText = typeof input.detailText === "string"
    ? input.detailText.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim()
    : "";
  if (detailText.length > EXPLAIN_DETAIL_MAX_CHARS) {
    throw new Error(`Keep the explanation under ${EXPLAIN_DETAIL_MAX_CHARS} characters.`);
  }
  if (reasonCode === "other") {
    if (detailText.length < EXPLAIN_OTHER_MIN_CHARS || wordCount(detailText) < EXPLAIN_OTHER_MIN_WORDS) {
      throw new Error(
        `Explain what happened in at least ${EXPLAIN_OTHER_MIN_WORDS} words (${EXPLAIN_OTHER_MIN_CHARS} characters) — where you were and what you did.`,
      );
    }
  }

  let confirmerHrId: string | null = null;
  if (reason.confirmerKinds.length > 0) {
    const raw = typeof input.confirmerHrId === "string" ? input.confirmerHrId.trim() : "";
    if (!raw) throw new Error("Choose who can confirm this.");
    confirmerHrId = raw;
  }

  return { confirmerHrId, detailText, reasonCode };
}

/** A deduction's own dates as clean ISO days, in order — whatever shape the stored JSON holds. */
export function caseDates(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => String(entry ?? "").slice(0, 10)).filter(isRealIsoDate))].sort();
}

/**
 * The one sentence a reviewer reads first — "Training · confirmer: Ahmed Ali". Also the
 * text stored in the legacy `claim_text` column, so an older reader still shows something true.
 */
export function explanationSummary(input: {
  reasonCode: ExplainReasonCode;
  detailText?: string | null;
  confirmerName?: string | null;
}): string {
  const head = explainReason(input.reasonCode).label;
  const detail = (input.detailText ?? "").trim();
  if (input.reasonCode === "other") return detail ? `${head}: ${detail}` : head;
  const confirmer = input.confirmerName?.trim() ? ` · confirmer: ${input.confirmerName.trim()}` : "";
  return detail ? `${head}${confirmer} — ${detail}` : `${head}${confirmer}`;
}

/** The "where to verify" text kept in the legacy `claim_source_text` column. */
export function explanationVerifySource(input: { reasonCode: ExplainReasonCode; confirmerName?: string | null }): string {
  if (input.reasonCode === "other") return "The employee's own explanation";
  const name = input.confirmerName?.trim();
  return name ? `Confirmed by ${name}` : "Named confirmer";
}

/**
 * The explanation as the reviewer's first facts on a case — the reason, and where the confirmation
 * stands — so the decision is taken with the confirmer's answer in front of him, never from memory.
 */
export function explanationFacts(
  explanation: DisputeExplanation,
): Array<{ label: string; value: string; tone?: "danger" | "info" | "success" | "warning" }> {
  const detail = explanation.detailText.trim();
  const reason = explainReason(explanation.reasonCode).label;
  const facts: Array<{ label: string; value: string; tone?: "danger" | "info" | "success" | "warning" }> = [
    { label: "Their reason", value: detail ? `${reason} — ${detail}` : reason },
  ];
  if (!explanation.confirmerHrId) {
    facts.push({ label: "Confirmation", value: "Nobody to confirm it — their own words" });
    return facts;
  }
  const who = explanation.confirmerName?.trim() || "The person they named";
  const note = explanation.confirmationNote?.trim();
  const status = explanation.confirmationStatus;
  facts.push({
    label: "Confirmation",
    tone: status === "confirmed" ? "success" : status === "declined" ? "danger" : "warning",
    value: `${who}: ${EXPLAIN_CONFIRMATION_LABELS[status]}${note ? ` — ${note}` : ""}`,
  });
  return facts;
}

/** The first confirmation state a new explanation is born with. */
export function initialConfirmationStatus(code: ExplainReasonCode): ExplainConfirmationStatus {
  return reasonNeedsConfirmer(code) ? "awaiting" : "not_needed";
}
