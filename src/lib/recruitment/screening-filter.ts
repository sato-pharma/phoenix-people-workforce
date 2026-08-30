// Recruitment / ATS — does one candidate belong in a narrowed screening queue?
//
// WHY THIS IS NOT INSIDE screening-queue.ts. The loader reaches the database on its first line, so
// a rule living beside it can only ever be tested by loading 482 production rows — which means in
// practice it is not tested at all, and the pool's Role filter shipped disagreeing with the pool's
// own screen for exactly that reason. Everything here is pure and takes a plain row, so
// tests/recruitment-screening-page.test.ts can hand it a candidate and assert the answer.
//
// PURE, and it has to stay that way for the same reason screening-link.ts does: its whole import
// chain (candidate-screening-facts -> candidate-region, candidate-role-family, employer-name, and
// applied-for) reaches no database and no Supabase client.
//
// THE ONE RULE WORTH KEEPING. Role, region and area all read `candidateScreeningFacts` — the SAME
// resolution the card in the queue renders — never the raw columns. The pool learned this the hard
// way: while its Role filter read `currentJobTitle` alone it disagreed with the screen, so Mahmoud
// Refaat Selim sat there showing "District Sales Manager, Alexandria" in his role cell with his
// title column NULL, and the one filter built to find him could not. Filtering on a different fact
// from the one displayed is not a narrower filter, it is a wrong one.

import { candidateRowAppliedFor, type AppliedForCandidateRow } from "@/lib/recruitment/applied-for";
import { candidateSourceChannel } from "@/lib/recruitment/candidate-source-context";
import {
  candidateScreeningFacts,
  candidateScreeningRoleFamily,
  type ScreeningFactsCandidateRow,
} from "@/lib/recruitment/candidate-screening-facts";
import { normalizeCandidateStatus } from "@/lib/recruitment/candidate-status";
import {
  SCREENING_UNKNOWN,
  type ScreeningQueueNarrowing,
  type ScreeningReceivedFilter,
} from "@/lib/recruitment/screening-link";

/** Just enough of a candidate to narrow on. Structural, so nothing here imports the domain type. */
export type ScreeningFilterCandidateRow = ScreeningFactsCandidateRow &
  AppliedForCandidateRow & {
    id: string;
    status?: string | null;
    /** When the CV arrived — read by the `received` filter. Absent never matches a window. */
    createdAt?: string | null;
    /** The last push straight to a manager, if any — read by the `notified` filter. */
    managerNotified?: { sentAt: string } | null;
    /** The raw source column, read alongside `sourceContext` — see `candidateSourceChannel`. */
    source?: string | null;
  };

const HOUR_MS = 60 * 60 * 1000;

/** How far back each `ScreeningReceivedFilter` window reaches, from `context.asOf`. */
const screeningReceivedWindowMs: Record<ScreeningReceivedFilter, number> = {
  day: 24 * HOUR_MS,
  hour: HOUR_MS,
  month: 30 * 24 * HOUR_MS,
  week: 7 * 24 * HOUR_MS,
};

/** Source labels are shown, not typed, so compare them the way a person reads them. */
export function screeningSourceKey(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * Every source channel this pool actually has, de-duplicated the way the card shows it.
 *
 * Built from `candidateSourceChannel` — the SAME resolution the pool's own Source column and filter
 * use — rather than the raw `source` column, for the reason this file's header already gives for
 * role/region/area: a NULL `source` column still resolves to "Manual", and reading the column alone
 * would offer a filter that cannot find the candidates it is supposed to.
 */
export function screeningSourceOptions(candidates: readonly ScreeningFilterCandidateRow[]): string[] {
  const byKey = new Map<string, string>();
  for (const candidate of candidates) {
    const label = candidateSourceChannel(candidate.source, candidate.sourceContext).label;
    const key = screeningSourceKey(label);
    if (!byKey.has(key)) byKey.set(key, label);
  }
  return [...byKey.values()].sort((a, b) => a.localeCompare(b, "en"));
}

/** Areas are free text an applicant typed; compare them the way a person would read them. */
export function screeningAreaKey(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * Every area an applicant in this pool has actually named, de-duplicated case-insensitively and
 * sorted the way a reader scans a list.
 *
 * Deliberately the areas applicants have NAMED, not every area the company has. Only 23 of 482
 * production candidates had answered the WhatsApp area question when this shipped, so a dropdown
 * built from the org structure would list ~60 areas of which ~50 can only ever return an empty
 * queue — which reads as a broken filter rather than as an honest "nobody from there has applied".
 *
 * First spelling wins on a case clash, because the value in the dropdown has to be a value the
 * filter can match and there is no canonical form to fold to — these are strings people typed.
 */
export function screeningAreaOptions(candidates: readonly ScreeningFilterCandidateRow[]): string[] {
  const byKey = new Map<string, string>();
  for (const candidate of candidates) {
    const value = candidateScreeningFacts(candidate).area?.value;
    if (!value) continue;
    const key = screeningAreaKey(value);
    if (!byKey.has(key)) byKey.set(key, value);
  }
  return [...byKey.values()].sort((a, b) => a.localeCompare(b, "en"));
}

/**
 * Does this candidate survive the narrowing carried by the link?
 *
 * `seen` is the one thing this cannot answer alone: "have I read this" is a fact about the VIEWER,
 * so the caller passes it in from the view map it loaded for the caller's own HR id. A viewer id in
 * a query string would let one person open a link that reports somebody else's reading as their own.
 */
export function matchesScreeningNarrowing(
  candidate: ScreeningFilterCandidateRow,
  narrowing: ScreeningQueueNarrowing,
  context: { seenByViewer: boolean; asOf: number },
): boolean {
  if (narrowing.status && normalizeCandidateStatus(candidate.status) !== narrowing.status) return false;
  if (narrowing.seen === "unseen" && context.seenByViewer) return false;
  if (narrowing.seen === "seen" && !context.seenByViewer) return false;

  if (narrowing.notified === "sent" && !candidate.managerNotified) return false;
  if (narrowing.notified === "unsent" && candidate.managerNotified) return false;

  if (narrowing.received) {
    const createdAtMs = candidate.createdAt ? new Date(candidate.createdAt).getTime() : NaN;
    // A row with no readable createdAt never matches a window rather than passing every one of
    // them — the same fail-closed choice `region`/`area` make for a fact nobody actually has.
    if (!Number.isFinite(createdAtMs) || context.asOf - createdAtMs > screeningReceivedWindowMs[narrowing.received]) {
      return false;
    }
  }

  if (narrowing.source) {
    const label = candidateSourceChannel(candidate.source, candidate.sourceContext).label;
    if (screeningSourceKey(label) !== screeningSourceKey(narrowing.source)) return false;
  }

  if (!narrowing.role && !narrowing.region && !narrowing.area) return true;

  const facts = candidateScreeningFacts(candidate);

  if (narrowing.role) {
    const family = candidateScreeningRoleFamily(facts, candidateRowAppliedFor(candidate).text);
    // `unknown` means nobody ever told us — a genuinely different claim from "Other", which is a
    // title we DO hold that names no job we recruit for.
    if (narrowing.role === SCREENING_UNKNOWN ? family !== null : family !== narrowing.role) return false;
  }

  if (narrowing.region) {
    const code = facts.region?.value.code ?? null;
    const foreign = Boolean(facts.region?.value.foreignCountry);
    // Three buckets, not two. A null code means either "we do not know where they live" or "we do,
    // and it is not in Egypt" — asking for the second under a heading that says the first would
    // misdescribe a person we actually have an address for.
    if (narrowing.region === "foreign") {
      if (!foreign) return false;
    } else if (narrowing.region === SCREENING_UNKNOWN) {
      if (code !== null || foreign) return false;
    } else if (code !== narrowing.region) {
      return false;
    }
  }

  if (narrowing.area) {
    const value = facts.area?.value ?? null;
    if (narrowing.area === SCREENING_UNKNOWN) {
      if (value) return false;
    } else if (screeningAreaKey(value) !== screeningAreaKey(narrowing.area)) {
      return false;
    }
  }

  return true;
}
