// Unified Deductions module: pure conflict-detection helpers. No DB I/O.
// Ported from deductions-governance/conflict.ts, keyed by category instead of
// deductionType so cross-category same-day overlaps (e.g. CRM vs No Records
// Activity both claiming the same day) surface too — see the mutual-exclusion
// rule the retired No Activity Days clarification flow used, generalized here.

import { canonicalHrIdKey } from "../hr-id.ts";
import { normalizeMonthKey } from "./candidate-key.ts";
import type { DeductionsCategory } from "./types.ts";

export function findDateOverlap(a: readonly string[], b: readonly string[]): string[] {
  const bSet = new Set<string>();
  for (const value of b) {
    if (typeof value === "string") {
      bSet.add(value.trim());
    }
  }
  const overlap = new Set<string>();
  for (const value of a) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (bSet.has(trimmed)) {
      overlap.add(trimmed);
    }
  }
  return [...overlap].sort();
}

export type DeductionsConflictResult = {
  conflicts: boolean;
  overlappingDates: string[];
  reason: string | null;
};

type ConflictCandidate = {
  employeeHrId: string;
  monthKey: string;
  category: DeductionsCategory;
  dates: readonly string[];
};

/**
 * Same-category conflict: the same employee, month, and category already has
 * an overlapping day (a duplicate/refreshed candidate from the same pipeline).
 */
export function detectCandidateConflict(a: ConflictCandidate, b: ConflictCandidate): DeductionsConflictResult {
  const aHr = canonicalHrIdKey(a.employeeHrId);
  const bHr = canonicalHrIdKey(b.employeeHrId);
  if (!aHr || !bHr || aHr !== bHr) {
    return { conflicts: false, overlappingDates: [], reason: null };
  }

  let aMonth: string;
  let bMonth: string;
  try {
    aMonth = normalizeMonthKey(a.monthKey);
    bMonth = normalizeMonthKey(b.monthKey);
  } catch {
    return { conflicts: false, overlappingDates: [], reason: null };
  }
  if (aMonth !== bMonth) {
    return { conflicts: false, overlappingDates: [], reason: null };
  }

  if (a.category !== b.category) {
    return { conflicts: false, overlappingDates: [], reason: null };
  }

  const overlappingDates = findDateOverlap(a.dates, b.dates);
  if (overlappingDates.length === 0) {
    return { conflicts: false, overlappingDates: [], reason: null };
  }

  return {
    conflicts: true,
    overlappingDates,
    reason: `Same employee, month, and category with overlapping dates (${overlappingDates.join(", ")})`,
  };
}

/**
 * Cross-category conflict: the same employee/day is claimed by two DIFFERENT
 * categories (e.g. CRM and No Records Activity both cover 2026-06-10 for the
 * same employee). Unlike detectCandidateConflict this does not require the
 * same category — it's the generalization of deductions-governance's
 * MANUAL_HR-vs-FIELD_WORKFORCE mutual-exclusion check to all 7 categories, so
 * the same day is never double-counted across pipelines.
 */
export function detectCrossCategoryConflict(a: ConflictCandidate, b: ConflictCandidate): DeductionsConflictResult {
  const aHr = canonicalHrIdKey(a.employeeHrId);
  const bHr = canonicalHrIdKey(b.employeeHrId);
  if (!aHr || !bHr || aHr !== bHr) {
    return { conflicts: false, overlappingDates: [], reason: null };
  }

  let aMonth: string;
  let bMonth: string;
  try {
    aMonth = normalizeMonthKey(a.monthKey);
    bMonth = normalizeMonthKey(b.monthKey);
  } catch {
    return { conflicts: false, overlappingDates: [], reason: null };
  }
  if (aMonth !== bMonth) {
    return { conflicts: false, overlappingDates: [], reason: null };
  }

  if (a.category === b.category) {
    return { conflicts: false, overlappingDates: [], reason: null };
  }

  const overlappingDates = findDateOverlap(a.dates, b.dates);
  if (overlappingDates.length === 0) {
    return { conflicts: false, overlappingDates: [], reason: null };
  }

  return {
    conflicts: true,
    overlappingDates,
    reason: `This day is already tracked by the "${a.category}" pipeline — decide it there instead of duplicating it under "${b.category}" (overlapping dates: ${overlappingDates.join(", ")})`,
  };
}

/** connectors/manual.ts's sourceSystem. Its `dates` are a placeholder anchor. */
export const MANUAL_ENTRY_SOURCE_SYSTEM = "manual_hr";

/** One live ledger row, as the connector reads it back to work out which days are already claimed. */
/** A failed read's own words — a PostgREST error is a plain object, not an `Error`. */
export function ledgerReadErrorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : String(error);
}

export type LedgerClaimRow = {
  employee_hr_id_compact?: string | null;
  dates: unknown;
  category?: string | null;
  locked_at?: string | null;
  source_system?: string | null;
};

/**
 * The `${compactHrId}:${date}` set a batch of live ledger rows already claims — the shared core of
 * the three connector "already deducted days" reads (vacation, holiday-bridge, dsm-no-record).
 *
 * A `manual_hr` row is SKIPPED, exactly as findDayCollisions skips it: connectors/manual.ts anchors
 * every manual Loan/Other entry to `${monthKey}-01` as a deterministic placeholder meaning "no
 * specific date", never a detected day. Counting that placeholder as a real claim dropped a genuine
 * same-category deduction that happened to fall on the real 1st of the month.
 *
 * `keepRow` lets a caller drop rows BEFORE their days count — the vacation reconcile passes
 * `ledgerRowStillClaimsItsDays` so a run does not block itself out of re-producing its own rows.
 * Pure, so the three reads can be unit-tested without the database.
 */
/**
 * The source-scoped twin of `connectors/vacation.ts`'s `ledgerRowStillClaimsItsDays`, for a
 * collector registered with `reconcilesSourceScope` instead of `reconcilesWholeCategory`.
 *
 * Same defect, same shape, different key. A collector whose re-run retires its own stale rows must
 * not read those rows as "this day is already charged": the fresh scan then emits nothing for the
 * day, and reconcile supersedes the row for being absent from the scan — so every other run flips
 * the set, and the owner's decision on each retired row goes with it. Measured on production for
 * `dsm_no_record` / 2026-09: rows created 2026-10-03 20:01 and 2026-10-06 03:40, 04:55, 23:35 and
 * 23:40 UTC alternate, three managers re-created and superseded on alternate runs while a fourth
 * flips the opposite way.
 *
 * The key is the SOURCE SYSTEM, never the category, because both of these collectors share their
 * category with another writer — `dsm_no_record` shares `crm` with `crm_visits_mirror`, and
 * `holiday_bridge` shares `other` with `manual_hr`. A sibling writer's row survives this run, so
 * its day is genuinely taken and must still claim; only the rows this run is itself about to
 * replace are excluded.
 *
 * 🔴 A LOCKED ROW IS THE EXCEPTION AND STILL CLAIMS ITS DAY. Reconcile refuses to supersede a
 * candidate with `locked_at` — published money is never retracted automatically — so that row is
 * still live after the run. Re-charging its day would put two live candidates on one employee-day,
 * which `findDayCollisions` cannot see (it reports only a day claimed by more than one CATEGORY)
 * and which surfaces as a raw unique_violation mid-publish from
 * `deductions_publication_lines_guard_day_overlap`.
 *
 * Fails CLOSED: a row whose `source_system` is missing or unrecognised keeps claiming its day. The
 * expensive mistake here is retiring a decided row, so an unknown row is left alone.
 */
export function ledgerRowStillClaimsItsDaysBySource(
  row: { sourceSystem: string | null; lockedAt: string | null },
  reconciledSourceSystems: readonly string[],
): boolean {
  const sourceSystem = String(row.sourceSystem ?? "").trim();
  // Not one of the sources this run reconciles — it survives the run, so the day is taken.
  if (!sourceSystem || !reconciledSourceSystems.includes(sourceSystem)) return true;
  // This run's own row. Only a published one survives; the rest are ours to replace.
  return Boolean(row.lockedAt);
}

export function collectClaimedLedgerDays(
  rows: ReadonlyArray<LedgerClaimRow>,
  keepRow?: (row: LedgerClaimRow) => boolean,
): Set<string> {
  const claimed = new Set<string>();
  for (const row of rows) {
    const compact = String(row.employee_hr_id_compact ?? "").trim();
    if (!compact) continue;
    if (!Array.isArray(row.dates)) continue;
    if (String(row.source_system ?? "").trim() === MANUAL_ENTRY_SOURCE_SYSTEM) continue;
    if (keepRow && !keepRow(row)) continue;
    for (const date of row.dates as unknown[]) {
      if (typeof date === "string" && date.trim()) claimed.add(`${compact}:${date.trim()}`);
    }
  }
  return claimed;
}

export type DeductionsDayCollision = {
  employeeHrId: string;
  employeeName: string | null;
  date: string;
  categories: DeductionsCategory[];
  sourceSystems: string[];
};

/**
 * Every (employee, day) claimed by MORE THAN ONE detection source in a set —
 * the double-deduction check, run across a whole month at once.
 *
 * This is the set-wide counterpart to detectCrossCategoryConflict's pairwise
 * check: publishing is an all-at-once operation, so the question that actually
 * matters is "does any day appear twice anywhere in what I'm about to pay?",
 * not "do these two specific rows clash?". O(n) over candidates rather than
 * O(n²) pairwise, which matters at ~2,000 candidates a month.
 *
 * A claim is (category, sourceSystem), NOT category alone. Unpaid Vacation is
 * found by two sources — the HR request (`vacation_balance`) and a CRM annual
 * leave record (`crm_vacation_signal`) — so the same absence produces two
 * candidates in ONE category. Keying on category alone made that invisible
 * here, and the (category, candidate_key) unique index cannot see it either
 * because only the source prefix inside the key differs. Measured on July 2026
 * production, 19 employee-days were claimed twice this way (8,822.54 EGP).
 *
 * Two candidates from the SAME category and source on one day are deliberately
 * still one claim: a genuine same-source duplicate (two overlapping approved
 * requests) is a defect in that source, to be rejected where it is entered.
 *
 * A `manual_hr` row makes NO claim on a day at all and is skipped. Its date is
 * not a detection — connectors/manual.ts anchors every manual Loan/Other entry
 * to `${monthKey}-01` as a deterministic placeholder, deliberately meaning "no
 * specific date", because HR types an amount and a reason, never a day. Reading
 * that placeholder as a real claim is a pure false positive, and widening the
 * key from category to (category, source) turned it into a live one: on
 * production 2026-07 the holiday bridge charges 2026-07-01 for one employee and
 * a manual Other entry is anchored to 2026-07-01 for another, both in category
 * `other`. Had they been the same person, the month's publish would abort with
 * "…2026-07-01 → other" — naming one category twice, and unresolvable, since
 * clearing either row deletes a legitimate deduction. Nothing is lost by
 * skipping: the gate never protected against a manual entry duplicating a
 * detected day, because the anchor never points at the day HR meant.
 *
 * Pure — no DB I/O — so it can be unit-tested and reused by both the collection
 * warning path and the publish gate.
 */
export function findDayCollisions(
  candidates: ReadonlyArray<{
    employeeHrId: string;
    employeeName?: string | null;
    employeeHrIdCompact: string;
    category: DeductionsCategory;
    /** Optional so an ad-hoc caller can omit it; claims that all omit it are
     *  indistinguishable and therefore count as a single claim. */
    sourceSystem?: string | null;
    dates: readonly string[];
  }>,
): DeductionsDayCollision[] {
  const seen = new Map<
    string,
    {
      employeeHrId: string;
      employeeName: string | null;
      date: string;
      claims: Map<string, { category: DeductionsCategory; sourceSystem: string }>;
    }
  >();

  for (const candidate of candidates) {
    const sourceSystem = typeof candidate.sourceSystem === "string" ? candidate.sourceSystem.trim() : "";
    // Placeholder date, not a detected day — see the note above.
    if (sourceSystem === MANUAL_ENTRY_SOURCE_SYSTEM) continue;
    const claimKey = `${candidate.category} ${sourceSystem}`;
    for (const rawDate of candidate.dates) {
      if (typeof rawDate !== "string") continue;
      const date = rawDate.trim();
      if (!date) continue;
      const key = `${candidate.employeeHrIdCompact}:${date}`;
      const entry = seen.get(key);
      if (entry) {
        entry.claims.set(claimKey, { category: candidate.category, sourceSystem });
      } else {
        seen.set(key, {
          employeeHrId: candidate.employeeHrId,
          employeeName: candidate.employeeName ?? null,
          date,
          claims: new Map([[claimKey, { category: candidate.category, sourceSystem }]]),
        });
      }
    }
  }

  const collisions: DeductionsDayCollision[] = [];
  for (const entry of seen.values()) {
    // >1 claim means two independent detections would each charge this day.
    if (entry.claims.size > 1) {
      const claims = [...entry.claims.values()];
      collisions.push({
        employeeHrId: entry.employeeHrId,
        employeeName: entry.employeeName,
        date: entry.date,
        categories: [...new Set(claims.map((claim) => claim.category))].sort(),
        sourceSystems: [...new Set(claims.map((claim) => claim.sourceSystem).filter(Boolean))].sort(),
      });
    }
  }
  return collisions.sort(
    (left, right) => left.employeeHrId.localeCompare(right.employeeHrId) || left.date.localeCompare(right.date),
  );
}

export type SettlementDraftLike = {
  employeeHrId: string;
  category: DeductionsCategory;
  monthKey: string;
  dates?: readonly string[] | null;
};

export type SettlementClaimRow = {
  employeeHrIdCompact: string;
  category: DeductionsCategory;
  sourceSystem?: string | null;
  dates: readonly string[];
};

/**
 * The final-settlement scan inserts and never reconciles (settlement.ts), so unlike a normal
 * collection it cannot retire an earlier row that covers the same days — and the leaver draft is keyed
 * `leaver_<hr>_<month>` while the normal CRM scan keys each day `live_<month>_..._<day>`, so the
 * candidate_key unique index sees two different rows. Measured on production 2026-09: a resigned
 * representative carried an APPROVED `live_` row for 27 September and a PENDING `leaver_` row for the
 * same day, both 533.33 EGP, both live — one approval away from a double charge.
 *
 * A draft that shares ANY day with a live row of the same employee and category is therefore held back,
 * never inserted. Not trimmed to the open days: the amount is derived from the weighted day count (a
 * Thursday is a half day) and the scan's base salary is not on the draft, so a trimmed row would carry
 * a wrong figure. The caller names the open days so the one that is not covered can be added by hand.
 *
 * Every live row claims, whatever its decision and whichever source wrote it: a day the reviewer
 * already cleared ("Do Not Take Action", or unticked) must not be proposed again, and a sibling
 * source's row (`dsm_no_record` shares `crm`) means the day is genuinely taken. A `manual_hr` row is
 * skipped, as in findDayCollisions — its date is a placeholder, not a detection.
 *
 * Pure — no DB I/O.
 */
export function splitDraftsByClaimedDays<D extends SettlementDraftLike>(
  drafts: readonly D[],
  live: ReadonlyArray<SettlementClaimRow>,
): { keep: D[]; held: Array<{ draft: D; claimedDates: string[]; openDates: string[] }> } {
  const claimed = new Map<string, Set<string>>();
  for (const row of live) {
    if (String(row.sourceSystem ?? "").trim() === "manual_hr") continue;
    const key = `${row.employeeHrIdCompact}\u0000${row.category}`;
    const days = claimed.get(key) ?? new Set<string>();
    for (const date of row.dates) {
      if (typeof date === "string" && date.trim()) days.add(date.trim());
    }
    claimed.set(key, days);
  }

  const keep: D[] = [];
  const held: Array<{ draft: D; claimedDates: string[]; openDates: string[] }> = [];
  for (const draft of drafts) {
    const compact = canonicalHrIdKey(draft.employeeHrId)?.replace(/[^a-z0-9]/g, "") ?? "";
    const days = claimed.get(`${compact}\u0000${draft.category}`);
    const draftDates = (draft.dates ?? []).filter((date): date is string => typeof date === "string" && date.trim() !== "");
    const claimedDates = days ? draftDates.filter((date) => days.has(date.trim())) : [];
    if (claimedDates.length === 0) {
      keep.push(draft);
      continue;
    }
    held.push({
      draft,
      claimedDates: [...claimedDates].sort(),
      openDates: draftDates.filter((date) => !days!.has(date.trim())).sort(),
    });
  }
  return { keep, held };
}

export class DeductionsConflictError extends Error {
  public readonly code = "DEDUCTIONS_CONFLICT" as const;
  public readonly overlappingDates: string[];

  constructor(overlappingDates: string[]) {
    super(`Deduction candidate conflicts with an existing entry on dates: ${overlappingDates.join(", ")}`);
    this.name = "DeductionsConflictError";
    this.overlappingDates = [...overlappingDates];
  }
}
