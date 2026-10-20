// The Disputes inbox's "why was this deducted" panel, written in words.
//
// Owner, 2026-10-08: "make me see in the window why was this deduction made so I can [decide]
// without going to another screen — in very much detail." A reply to a dispute is only as good as
// what the person answering can see, and before this the thread showed a category, an amount and a
// day count: the reason a deduction exists lived in the Pending tab of a month, on another screen.
//
// Pure on purpose (no database, no network): the read in portal.ts hands this the rows it already
// loaded, and tests/deductions-dispute-basis.test.ts pins every branch without a connection.
//
// 🔴 NO HR CODE EVER REACHES A FACT. The evidence column carries identifiers — a recommendationKey
// like `payroll_deduction:no_activity_candidate:AI-0002:…`, a device user id, an `enteredBy` login —
// that are provenance for an auditor and noise (or an HR code) for a reader. So the facts come from
// a WHITELIST of keys per source, never from walking the object: an unknown key is left out rather
// than printed, which is the safe direction for a screen the owner reads names on.

import type {
  DeductionDisputeBasis,
  DeductionDisputeDecision,
  DeductionDisputeFact,
  DeductionsPortalLine,
  DeductionsSeverity,
  DeductionsUnit,
} from "./types.ts";

export type DisputeCandidateRow = {
  id: string;
  category: string;
  source_system: string | null;
  unit: string | null;
  raw_value: number | string | null;
  estimated_amount: number | string | null;
  calculation_status: string | null;
  severity: string | null;
  reason: string | null;
  evidence: unknown;
  dates: unknown;
};

export type DisputeDecisionRow = {
  candidate_id: string;
  decision_status: string | null;
  decision_reason: string | null;
  hr_note: string | null;
  applied_value: number | string | null;
  applied_amount: number | string | null;
  applied_dates: unknown;
  decided_by: string | null;
  decided_at: string | null;
};

export type DisputeLineExtraRow = {
  candidate_id: string;
  pushed_at: string | null;
  pushed_by: string | null;
};

type SourceProfile = {
  /** What kind of check raised it, in a few words. */
  detectedBy: string;
  /** How that check works — the rule the employee is being measured against. */
  explanation: string;
};

const SOURCE_PROFILES: Record<string, SourceProfile> = {
  fingerprint_report: {
    detectedBy: "Fingerprint attendance report",
    explanation:
      "The day's first and last fingerprint punches were compared with the working hours. Lateness, a short day or leaving early with no approved leave or excuse is charged as part of a day.",
  },
  crm_visits_mirror: {
    detectedBy: "Field CRM — a working day with no activity",
    explanation:
      "The CRM shows no visit activity for the person on these working days, and nothing else covers them (no approved leave, holiday or plan). A day with no CRM activity is deducted unless HR clears it.",
  },
  dsm_no_record: {
    detectedBy: "District manager CRM record",
    explanation:
      "A district manager is recorded in the CRM through the rep's double visit. A working day with neither a double-visit tag nor an own visit is a day with no record.",
  },
  crm_half_day: {
    detectedBy: "Field CRM — a half day left unaccounted for",
    explanation:
      "On a working day exactly one half (morning or afternoon) was accounted for, and nothing covers the other half: no visit, GPS check-in, approved vacation or request. An approved weekly plan is not coverage — owner, 2026-10-12.",
  },
  crm_vacation_signal: {
    detectedBy: "CRM vacation record against the leave balance",
    explanation:
      "The CRM recorded the person on vacation, and the leave balance did not cover it, so those days are unpaid.",
  },
  vacation_balance: {
    detectedBy: "Leave balance — vacation beyond the entitlement",
    explanation:
      "An approved vacation request used more days than the leave balance allowed. The days beyond the entitlement are unpaid and are charged to the month they fall in.",
  },
  holiday_bridge: {
    detectedBy: "Holiday bridge",
    explanation:
      "The day sits directly beside a public holiday, so taking it joins the holiday to the weekend or to working days and it is charged.",
  },
  manual_hr: {
    detectedBy: "Entered by hand by HR",
    explanation: "This deduction was typed in by HR rather than detected by a check.",
  },
  hr_ops_report: {
    detectedBy: "HR operations daily or weekly report",
    explanation:
      "HR operations reviewed the field day's visits in its daily or weekly report, and the deduction was then decided in days. The day went to the employee in the weekly attendance review, where they chose salary or annual balance, or disputed it.",
  },
  no_activity_engine: {
    detectedBy: "No-activity check (retired)",
    explanation: "Raised by the earlier no-activity check, since retired; kept as history.",
  },
};

const FALLBACK_PROFILE: SourceProfile = {
  detectedBy: "Deductions module",
  explanation: "Raised by the deductions module.",
};

export function disputeSourceProfile(sourceSystem: string | null | undefined): SourceProfile {
  return SOURCE_PROFILES[String(sourceSystem ?? "")] ?? FALLBACK_PROFILE;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sept", "Oct", "Nov", "Dec"] as const;

/** "2026-09-07" -> "7 Sept 2026". Date-only: read off the string, never through a zone. */
export function disputeDateLabel(iso: string): string {
  if (!ISO_DATE.test(iso)) return iso;
  const [year, month, day] = iso.split("-").map(Number);
  return `${day} ${MONTHS[month - 1] ?? ""} ${year}`.replace("  ", " ");
}

function humanize(value: string): string {
  const spaced = value.replace(/[_-]+/g, " ").trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : spaced;
}

const UNPAID_REASON_LABELS: Record<string, string> = {
  first_six_months: "Still inside the first six months of service, so there is no paid entitlement yet",
  missing_hire_date: "No hire date on record, so the entitlement could not be worked out",
  insufficient_balance: "The leave balance did not cover the request",
  no_balance: "No leave balance was available",
};

function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return null;
}

function dateList(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const dates = value.filter((entry): entry is string => typeof entry === "string").map(disputeDateLabel);
  return dates.length > 0 ? dates.join(", ") : null;
}

function plainList(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const parts = value.map((entry) => str(entry)).filter((entry): entry is string => Boolean(entry));
  return parts.length > 0 ? parts.join(", ") : null;
}

type FactSpec = {
  key: string;
  label: string;
  /** Shown as this when the key is present but empty — an absence the reader should SEE. */
  whenEmpty?: string;
  format?: (value: unknown) => string | null;
};

const asDate = (value: unknown) => {
  const text = str(value);
  return text ? disputeDateLabel(text) : null;
};

const FACT_SPECS: Record<string, FactSpec[]> = {
  fingerprint_report: [
    { key: "status", label: "Attendance status" },
    { key: "actualFirstPunch", label: "First fingerprint of the day" },
    { key: "actualLastPunch", label: "Last fingerprint of the day" },
    { key: "lateMinutes", label: "Arrived late by (minutes)" },
    { key: "earlyLeaveMinutes", label: "Left early by (minutes)" },
    { key: "approvedLeave", label: "Approved leave that day", whenEmpty: "None on record" },
    { key: "approvedExcuse", label: "Approved excuse that day", whenEmpty: "None on record" },
    { key: "crmActivity", label: "CRM activity that day", whenEmpty: "None on record" },
    { key: "weeklyPlan", label: "Weekly plan for the day" },
    { key: "jobTitle", label: "Job title" },
    { key: "department", label: "Department" },
  ],
  dsm_no_record: [
    { key: "workingDaysConsidered", label: "Working days checked in the month" },
    { key: "deductionDaysWeighted", label: "Days charged" },
    { key: "holidaysExcluded", label: "Holidays left out", format: dateList },
    { key: "suspectDatesExcluded", label: "Days left out as unreliable CRM data", format: dateList },
  ],
  crm_half_day: [
    { key: "role", label: "Role" },
    { key: "missingHalf", label: "Half left unaccounted for" },
    { key: "coveredBy", label: "Half that was accounted for by" },
    { key: "visitsTaggedAm", label: "Morning visits recorded" },
    { key: "visitsTaggedPm", label: "Afternoon visits recorded" },
    { key: "visitsWholeDayOrUntimed", label: "Whole-day or untimed visits" },
    { key: "campaignVisits", label: "Campaign visits" },
    { key: "creditedAsDoubleVisitPartner", label: "Credited as a double-visit partner" },
    { key: "approvedVacation", label: "Approved vacation", whenEmpty: "None on record" },
    {
      // Historic only — the half-day connector stopped writing this on 2026-10-12, when an approved
      // weekly plan stopped covering a half. Kept so a dispute on a row raised before that still
      // shows the fact it was decided on; `whenEmpty` never fires, because absent keys are skipped.
      key: "approvedPlan",
      label: "Approved plan item (no longer coverage)",
      whenEmpty: "None on record",
      format: (value) => {
        if (!value || typeof value !== "object") return null;
        const plan = value as { am?: boolean; pm?: boolean };
        if (plan.am && plan.pm) return "Morning and afternoon";
        if (plan.am) return "Morning";
        if (plan.pm) return "Afternoon";
        return null;
      },
    },
    { key: "holidaysExcluded", label: "Holidays left out", format: dateList },
    { key: "suspectDatesExcluded", label: "Days left out as unreliable CRM data", format: dateList },
    { key: "gpsGapDatesExcluded", label: "Days left out for missing GPS check-ins", format: dateList },
  ],
  crm_visits_mirror: [
    { key: "hireDate", label: "Hire date", format: asDate },
    { key: "leaverLastWorkingDate", label: "Last working day", format: asDate },
    { key: "excludedSuspectDates", label: "Days left out as unreliable CRM data", format: dateList },
    { key: "suspectDateReason", label: "Why those days were left out" },
  ],
  crm_vacation_signal: [
    {
      key: "unpaidReason",
      label: "Why the vacation is unpaid",
      format: (value) => {
        const text = str(value);
        return text ? UNPAID_REASON_LABELS[text] ?? humanize(text) : null;
      },
    },
    { key: "hireDate", label: "Hire date", format: asDate },
    { key: "entitlementDays", label: "Vacation entitlement (days)" },
    { key: "balanceBeforeDays", label: "Balance before this vacation (days)" },
    { key: "vacationAmpm", label: "Part of the day on vacation", format: plainList },
    { key: "workAmpm", label: "Part of the day with work recorded", format: plainList },
    {
      key: "mixedDay",
      label: "Vacation and work on the same day",
      format: (value) => (value === true ? "Yes — confirm full day, morning or afternoon" : null),
    },
    { key: "periodStart", label: "Entitlement year starts", format: asDate },
    { key: "periodEnd", label: "Entitlement year ends", format: asDate },
  ],
  vacation_balance: [
    { key: "vacationType", label: "Vacation type", format: (value) => (str(value) ? humanize(String(value)) : null) },
    {
      key: "unpaidReason",
      label: "Why the days are unpaid",
      format: (value) => {
        const text = str(value);
        return text ? UNPAID_REASON_LABELS[text] ?? humanize(text) : null;
      },
    },
    { key: "requestStartDate", label: "Request starts", format: asDate },
    { key: "requestEndDate", label: "Request ends", format: asDate },
    { key: "totalUnpaidDaysOnRequest", label: "Unpaid days on the whole request" },
    { key: "apportionment", label: "Share charged to this month" },
    { key: "paymentStatus", label: "Payment status", format: (value) => (str(value) ? humanize(String(value)) : null) },
  ],
  holiday_bridge: [
    { key: "holidayName", label: "Holiday" },
    { key: "holidayStartDate", label: "Holiday starts", format: asDate },
    { key: "holidayEndDate", label: "Holiday ends", format: asDate },
    { key: "adjacentTo", label: "The day is", format: (value) => (str(value) ? `${humanize(String(value))} the holiday` : null) },
    { key: "cause", label: "Cause" },
  ],
  // Written by src/lib/hr-ops-reports/bridge.ts. Names and words only: who decided is provenance
  // (an HR code) and is deliberately not a fact.
  hr_ops_report: [
    { key: "section", label: "Reviewed as" },
    { key: "issuesFound", label: "What the report found", format: plainList },
    { key: "reviewNote", label: "HR operations note" },
    { key: "decidedDays", label: "Days decided" },
    { key: "decidedOn", label: "Decided on", format: asDate },
  ],
};
function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toDates(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export function buildDisputeFacts(sourceSystem: string | null, evidence: unknown): DeductionDisputeFact[] {
  const specs = FACT_SPECS[String(sourceSystem ?? "")] ?? [];
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return [];
  const record = evidence as Record<string, unknown>;
  const facts: DeductionDisputeFact[] = [];
  for (const spec of specs) {
    if (!(spec.key in record)) continue;
    const raw = record[spec.key];
    const text = spec.format ? spec.format(raw) : str(raw);
    if (text) facts.push({ label: spec.label, value: text });
    else if (spec.whenEmpty) facts.push({ label: spec.label, value: spec.whenEmpty });
  }
  return facts;
}

/** The rule sentence a check wrote into its own evidence, when it did — more exact than ours. */
function evidenceRule(evidence: unknown): string | null {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return null;
  return str((evidence as Record<string, unknown>).rule);
}

/** The day-rate sentence the half-day check wrote into its evidence. */
function evidenceRateBasis(evidence: unknown): string | null {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return null;
  return str((evidence as Record<string, unknown>).dayRateBasis);
}

function money(value: number | null): number | null {
  return value === null ? null : Math.round(value * 100) / 100;
}

export function buildDisputeBasis(input: {
  candidate: DisputeCandidateRow;
  decision: DisputeDecisionRow | null;
  line: DeductionsPortalLine;
  lineExtra: DisputeLineExtraRow | null;
  nameFor: (hrId: string | null | undefined) => string | null;
}): DeductionDisputeBasis {
  const { candidate, decision, line, lineExtra, nameFor } = input;
  const profile = disputeSourceProfile(candidate.source_system);
  const unit: DeductionsUnit = candidate.unit === "amount" ? "amount" : "days";
  const detectedValue = toNumber(candidate.raw_value) ?? 0;
  const estimatedAmount = toNumber(candidate.estimated_amount);
  const ratePerUnit =
    unit === "days" && estimatedAmount !== null && detectedValue > 0 ? money(estimatedAmount / detectedValue) : null;

  const severity = candidate.severity as DeductionsSeverity | null;

  let decisionBlock: DeductionDisputeDecision | null = null;
  if (decision) {
    decisionBlock = {
      status: String(decision.decision_status ?? "Pending"),
      reason: String(decision.decision_reason ?? "").trim(),
      hrNote: String(decision.hr_note ?? "").trim(),
      decidedByName: nameFor(decision.decided_by),
      decidedAt: decision.decided_at ?? null,
      appliedValue: toNumber(decision.applied_value),
      appliedAmount: toNumber(decision.applied_amount),
      appliedDates: Array.isArray(decision.applied_dates) ? toDates(decision.applied_dates) : null,
    };
  }

  return {
    detectedBy: profile.detectedBy,
    explanation: evidenceRule(candidate.evidence) ?? profile.explanation,
    reason: str(candidate.reason),
    severity,
    needsReview: candidate.calculation_status === "requires_review",
    unit,
    detectedValue,
    detectedDates: toDates(candidate.dates),
    estimatedAmount,
    ratePerUnit,
    rateBasis:
      evidenceRateBasis(candidate.evidence) ??
      (unit === "days" ? "Base salary ÷ the actual calendar days of the month" : null),
    facts: buildDisputeFacts(candidate.source_system, candidate.evidence),
    decision: decisionBlock,
    chargedAmount: line.appliedAmount,
    chargedValue: line.appliedDeductionValue,
    publishedAt: line.createdAt,
    pushedAt: lineExtra?.pushed_at ?? null,
    pushedByName: nameFor(lineExtra?.pushed_by),
  };
}
