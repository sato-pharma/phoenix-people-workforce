// Unified Deductions module: orchestrates every automated connector for one
// month into the candidate ledger. Loan/Other are excluded here — those are
// one-at-a-time HR entries (see connectors/manual.ts + service.ts's
// insertCandidateDrafts with autoDecideStatus), not a company-wide scan.
//
// Work is exposed one connector at a time on purpose. Running all of them inside a
// single HTTP request is what got the first cut of this module reverted (#1377):
// each connector is a company-wide scan, nothing bounded how slow they were
// together, and the request burned the full 300s Cloud Run limit and was killed.
// Callers that face a request timeout must drive `DEDUCTION_COLLECTORS`
// one at a time via `collectOneConnectorForMonth`.

import { currentCairoDateParts } from "@/lib/i18n/format";
import { crmCutoverMonthDeductionNote, isCrmCutoverMonth, readCrmCutoverSetting } from "@/lib/crm/cutover.ts";
import { applyAcceptedDailyDisputes } from "@/lib/daily-deductions/accepted-dispute-days.ts";

import { compactDeductionsHrId, deductionsCandidateIdentityKey } from "./candidate-key.ts";
import {
  calendarMonthLabel,
  calendarMonthsInWindow,
  clipDraftToCycleWindow,
  cycleCoversEmployee,
  cycleWindow,
  cycleWindowLabel,
  isCycleWindowCollectable,
  isSplitCycleMonth,
  mergeCycleDrafts,
  monthKeyOf,
  shiftMonth,
  type DeductionCycle,
  type PayrollMonth,
} from "./cycle.ts";
import { dropDeductionExemptDrafts } from "./exempt-employees.ts";
import { collectFingerprintCandidates } from "./connectors/fingerprint.ts";
import { collectDsmNoRecordCandidates } from "./connectors/dsm-no-record.ts";
import { collectHalfDayCandidates } from "./connectors/half-day.ts";
import { collectHolidayBridgeCandidates } from "./connectors/holiday-bridge.ts";
import { collectCrmCandidates } from "./connectors/crm.ts";
import {
  collectInsufficientBalanceVacationCandidates,
  collectUnpaidVacationCandidates,
} from "./connectors/vacation.ts";
import { splitDraftsByClaimedDays } from "./conflict.ts";
import { loadOnePartEmployeeCompacts } from "./cycle-population.ts";
import {
  insertCandidateDrafts,
  listCandidatesForMonth,
  prepareCandidateInsertPayload,
  reconcileCandidateDrafts,
  type CandidateDraftInsertResult,
} from "./service.ts";
import type { DeductionsCandidate, DeductionsCandidateDraft, DeductionsCategory } from "./types.ts";

export type DeductionCollectorKey =
  | "fingerprint"
  | "crm"
  | "no_records_activity"
  | "unpaid_vacation"
  | "insufficient_balance_vacation"
  | "dsm_no_record"
  | "crm_half_day"
  | "holiday_bridge";

export type MonthlyCollectionResult = Record<DeductionCollectorKey, CandidateDraftInsertResult>;

type CollectorInput = { month: number; year: number; createdBy: string };

/** Today in Cairo as YYYY-MM-DD — the office window's own end is compared against it. */
function cairoTodayIso(): string {
  const { year, month, day } = currentCairoDateParts();
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Owner decision 18's visible half. The CRM connector returns nothing for the cutover month; this
 * says WHY on the collection result, so "created 0" is never read as "every rep was active".
 * Never throws: the connector already failed closed on an unreadable setting, and a note must not
 * turn a finished reconcile into "connector failed".
 */
async function withCrmCutoverMonthNote(
  result: CandidateDraftInsertResult,
  period: { month: number; year: number },
): Promise<CandidateDraftInsertResult> {
  try {
    if (!isCrmCutoverMonth(await readCrmCutoverSetting(), period)) return result;
  } catch {
    return result;
  }
  return { ...result, warnings: [...result.warnings, crmCutoverMonthDeductionNote(period)] };
}

/**
 * What a connector hands back: its drafts, or its drafts plus NOTES — the findings it detected but
 * could not raise (a day another category already charges, an employee with no salary on file).
 * The notes ride out on the collection result's warnings, so a finding is never dropped in silence.
 */
export type CollectorOutput = DeductionsCandidateDraft[] | { drafts: DeductionsCandidateDraft[]; notes: string[] };

/** Splits a connector's output into its drafts and its notes, whichever shape it returned. */
export function collectorOutputParts(output: CollectorOutput): { drafts: DeductionsCandidateDraft[]; notes: string[] } {
  return Array.isArray(output) ? { drafts: output, notes: [] } : output;
}

type Collector = {
  key: DeductionCollectorKey;
  label: string;
  run: (input: CollectorInput) => Promise<CollectorOutput>;
  /**
   * Set only when this collector is the ONLY writer of that category, and its
   * run covers the whole company for the whole month. Then a re-run is a
   * replacement: anything live in the category the fresh scan no longer emits
   * has been retracted at the source and is superseded instead of left standing.
   *
   * Leave unset wherever a category has more than one writer — superseding on
   * behalf of another writer would delete its work. `crm` is written by both the
   * CRM and district-manager collectors; `other` by the holiday bridge and by
   * manual HR entries.
   */
  reconcilesWholeCategory?: DeductionsCategory;
  /**
   * The narrower form of the same idea, for a category with MORE THAN ONE writer: this collector
   * is the only writer of these `sourceSystems`, so it may retire its own stale rows without
   * touching a sibling's.
   *
   * This is what makes a correction actually correct something. While these collectors were
   * insert-only, a fixed re-collect could only ADD a row — the wrong one stayed live beside it,
   * because `candidate_key` embeds a hash of the day set, so a recalculation looks like a
   * brand-new finding. Measured on July 2026 production: 7 employee-days charged twice
   * (3,419.35 EGP), and 14,629.01 EGP of false CRM deductions that no re-run could retract.
   */
  reconcilesSourceScope?: { category: DeductionsCategory; sourceSystems: readonly string[] };
};

/**
 * The automated connectors, in the order they should be run. Exported so the
 * admin UI can drive them one request at a time and show per-connector progress.
 */
export const DEDUCTION_COLLECTORS: readonly Collector[] = [
  {
    key: "fingerprint",
    label: "Fingerprint attendance report",
    reconcilesSourceScope: { category: "fingerprint", sourceSystems: ["fingerprint_report"] },
    run: collectFingerprintCandidates,
  },
  {
    key: "crm",
    label: "CRM no-activity",
    // `crm` is shared with dsm_no_record, so scope the retraction to this writer's own source.
    reconcilesSourceScope: { category: "crm", sourceSystems: ["crm_visits_mirror"] },
    run: collectCrmCandidates,
  },
  // no_records_activity is NOT here. Its connector has no population left: the field
  // workforce belongs to `crm`, and Head Office has no CRM obligation, which between
  // them is everybody. Leaving it registered made the collection UI offer a step that
  // always reports "created=0" and the workspace render a permanently empty category —
  // an operator cannot tell that apart from a broken connector. The category constant
  // and its historical rows stay untouched; only the live collection step is retired.
  //
  // Both vacation collectors reconcile. A vacation day is found by two sources —
  // the HR request and a CRM annual-leave record — and the HR request wins, so
  // once a request is filed for a day CRM already flagged, the CRM candidate is
  // no longer supported by the source. Insert-only left it live and the same day
  // was charged twice (July 2026 production: 19 employee-days, 8,822.54 EGP).
  {
    key: "unpaid_vacation",
    label: "Unpaid Vacation",
    reconcilesWholeCategory: "unpaid_vacation",
    run: collectUnpaidVacationCandidates,
  },
  {
    key: "insufficient_balance_vacation",
    label: "Insufficient Balance Vacation",
    reconcilesWholeCategory: "insufficient_balance_vacation",
    run: collectInsufficientBalanceVacationCandidates,
  },
  // After the four that own their own populations, before holiday_bridge. Like
  // holiday_bridge it dedups against the live ledger, so it must not run before
  // the categories whose days it needs to avoid.
  {
    key: "dsm_no_record",
    label: "District manager CRM no-record days",
    reconcilesSourceScope: { category: "crm", sourceSystems: ["dsm_no_record"] },
    run: collectDsmNoRecordCandidates,
  },
  // The half days (owner, 2026-10-08). After every connector whose days it must not double-charge
  // — it skips a date another live row already claims, and reports it — and before holiday_bridge,
  // which must stay last. Sole writer of its category, so a re-run replaces its own rows.
  {
    key: "crm_half_day",
    label: "Half Day (CRM)",
    reconcilesWholeCategory: "crm_half_day",
    run: collectHalfDayCandidates,
  },
  // LAST on purpose. Its dedup reads the live ledger to skip any employee-day
  // another category already charges, so it must run after those categories
  // have been written — running it first would find an empty ledger and
  // manufacture the exact duplicates the rule forbids.
  {
    key: "holiday_bridge",
    label: "Governmental-holiday bridging",
    // `other` is shared with manual_hr entries — never retire a hand-entered deduction.
    reconcilesSourceScope: { category: "other", sourceSystems: ["holiday_bridge"] },
    run: collectHolidayBridgeCandidates,
  },
];

const COLLECTORS_BY_KEY = new Map(DEDUCTION_COLLECTORS.map((collector) => [collector.key, collector]));

export function isDeductionCollectorKey(value: unknown): value is DeductionCollectorKey {
  return typeof value === "string" && COLLECTORS_BY_KEY.has(value as DeductionCollectorKey);
}

/**
 * Refuses to collect a month that has not finished.
 *
 * Owner's rule (2026-08-03), and it is not theoretical: collecting an in-progress
 * month happened three times in one day and every time it charged people for days
 * that had not ended. On 3 August a run produced 72 candidates covering 1-3
 * August — 69 of them CRM, which is mandatory-unless-cleared and publishes with
 * NO approval step — for 39,225.73 EGP. An earlier pair of accidental runs added
 * 28 more. All were withdrawn, but only because somebody noticed.
 *
 * A no-activity day is only meaningful once the day is over. Judging today, or a
 * day still to come, is not a strict rule — it is a wrong one.
 *
 * CAIRO boundaries, not UTC. The deductions page already seeds its month key from
 * `currentCairoDateParts` for exactly this reason: in the first two or three hours
 * of a Cairo month a UTC clock still reads the previous month, so a UTC guard
 * would wave through the very window it exists to block.
 *
 * Exported so callers and tests can ask the question without triggering a run.
 */
export function isCollectableMonth(input: { month: number; year: number }): boolean {
  const { month, year } = currentCairoDateParts();
  // Strictly earlier than the current Cairo month. A future month is refused too:
  // there is nothing to detect, and collecting one would create candidates for
  // days nobody has worked yet.
  return input.year < year || (input.year === year && input.month < month);
}

/**
 * Runs exactly one connector for one month and writes whatever's new into
 * deductions_candidates. The connector's own idempotency probe means re-running
 * this for the same month and connector is always safe — already-live
 * candidates are skipped, not duplicated. A connector that declares
 * `reconcilesWholeCategory` goes further: its live candidates the fresh scan no
 * longer emits are superseded, so a re-run replaces rather than accumulates.
 *
 * A connector that throws is reported as a warning rather than propagated, so a
 * caller stepping through all five gets the same "one failure does not stop the
 * others" isolation the single-shot version had. The throw also happens BEFORE
 * either write, which is what keeps reconciliation safe: a failed scan can never
 * be mistaken for "the source retracted everything".
 */
export async function collectOneConnectorForMonth(
  input: CollectorInput & { connector: DeductionCollectorKey; cycle?: DeductionCycle },
): Promise<CandidateDraftInsertResult> {
  const collector = COLLECTORS_BY_KEY.get(input.connector);
  if (!collector) {
    throw new Error(`Validation: unknown deductions connector "${input.connector}".`);
  }

  // The Head Office cycle (owner, 2026-10-26) has its own door with its own end-of-window guard.
  if ((input.cycle ?? "calendar") === "office") {
    return collectOneConnectorForOfficeCycle({ ...input, collector });
  }

  // Before anything reads source data. THROWS rather than returning an empty
  // result: "created 0" is indistinguishable from "nobody qualified", and this
  // needs to be unmissable.
  if (!isCollectableMonth(input)) {
    const cairo = currentCairoDateParts();
    throw new Error(
      `Validation: ${String(input.month).padStart(2, "0")}/${input.year} has not finished — collection only runs on a completed month. ` +
        `Today is ${String(cairo.month).padStart(2, "0")}/${cairo.year} in Cairo. Collecting an in-progress month charges people for days that have not ended, ` +
        `and CRM candidates publish without an approval step.`,
    );
  }

  const { month, year, createdBy } = input;
  try {
    // From October 2026 the calendar month covers only the employees paid in TWO parts; the one-part
    // employees are on the Head Office cycle. Read BEFORE the connector, so an unreadable directory
    // refuses the run rather than charging the one-part employees' days a second time.
    const employeeFilter = await calendarEmployeeFilter({ month, year });
    const output = await collector.run({ month, year, createdBy });
    const parts = collectorOutputParts(output);
    // People the owner took out of every deduction type are dropped BEFORE reconciling, so a
    // re-run also retires their still-live rows rather than leaving them standing.
    const { kept: exemptionFree } = dropDeductionExemptDrafts(parts.drafts);
    // From the cutover the calendar run keeps only its own population (two-part pay).
    const unheld = employeeFilter
      ? exemptionFree.filter((draft) => employeeFilter(compactDeductionsHrId(draft.employeeHrId) ?? ""))
      : exemptionFree;
    // From the cutover, a day already on the OTHER cycle's row is never added again.
    const crossCycle = employeeFilter ? await applyCrossCycleHold(unheld, { month, year }) : { drafts: unheld, notes: [] };
    // A day the employee WON a dispute on, on a released daily deduction, is never charged again
    // (owner, 2026-11-13, "Withdraw + never charge"). Fails closed: a failed read fails the connector.
    const spared = await applyAcceptedDailyDisputes(crossCycle.drafts);
    const drafts = spared.drafts;
    const notes = [...parts.notes, ...crossCycle.notes, ...spared.notes];
    const withNotes = (result: CandidateDraftInsertResult): CandidateDraftInsertResult =>
      notes.length === 0 ? result : { ...result, warnings: [...result.warnings, ...notes] };
    if (collector.reconcilesWholeCategory) {
      return withNotes(await reconcileCandidateDrafts({
        createdBy,
        drafts,
        scope: {
          category: collector.reconcilesWholeCategory,
          monthKey: `${year}-${String(month).padStart(2, "0")}`,
          employeeFilter,
        },
        sourceLabel: collector.label,
      }));
    }
    if (collector.reconcilesSourceScope) {
      const reconciled = await reconcileCandidateDrafts({
        createdBy,
        drafts,
        scope: {
          category: collector.reconcilesSourceScope.category,
          monthKey: `${year}-${String(month).padStart(2, "0")}`,
          sourceSystems: collector.reconcilesSourceScope.sourceSystems,
          employeeFilter,
        },
        sourceLabel: collector.label,
      });
      return withNotes(collector.key === "crm" ? await withCrmCutoverMonthNote(reconciled, { month, year }) : reconciled);
    }
    return withNotes(await insertCandidateDrafts({ createdBy, drafts, sourceLabel: collector.label }));
  } catch (error) {
    return {
      created: 0,
      skippedExisting: 0,
      warnings: [`${collector.label}: connector failed: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

/**
 * Who the CALENDAR run covers in a month, as a compact-HR-id filter — or undefined before the
 * October 2026 cutover, when it covers everyone exactly as it always has.
 */
async function calendarEmployeeFilter(period: PayrollMonth): Promise<((compact: string) => boolean) | undefined> {
  if (!isSplitCycleMonth(period)) return undefined;
  const onePart = await loadOnePartEmployeeCompacts();
  return (compact) => cycleCoversEmployee("calendar", period, onePart.has(compact));
}

type CrossCycleLiveRow = Pick<
  DeductionsCandidate,
  "monthKey" | "employeeHrIdCompact" | "category" | "sourceSystem" | "dates" | "candidateKey"
>;

/**
 * THE CROSS-CYCLE HOLD. Who is on which cycle is read from the employee directory when a run starts,
 * so an employee whose payment mode changes between two runs can be judged by BOTH: paid in two parts
 * for October (calendar run, 1–31 October), then in one part for November (office window, 22 October
 * → 21 November) — 22–31 October charged twice. A row an older path keyed to the calendar month for a
 * day the office cycle now owns is the same overlap.
 *
 * A draft is HELD — never inserted — when a live row of the same person and category, keyed to a
 * DIFFERENT payroll month, already claims one of its days (any decision, as splitDraftsByClaimedDays
 * reads a claim). A row keyed to the draft's own month is the reconcile's business, and a draft whose
 * identity is already live under its own month is KEPT: it inserts nothing new, and dropping it would
 * make the reconcile retire that row as "no longer emitted".
 *
 * Pure — the caller reads the live rows.
 */
export function holdCrossCycleClaimedDrafts(input: {
  drafts: readonly DeductionsCandidateDraft[];
  live: ReadonlyArray<CrossCycleLiveRow>;
  identityOf: (draft: DeductionsCandidateDraft) => string | null;
}): { keep: DeductionsCandidateDraft[]; notes: string[] } {
  const ownMonthIdentities = new Set(
    input.live.map((row) => `${row.monthKey}\u0000${deductionsCandidateIdentityKey(row.candidateKey)}`),
  );
  const keep: DeductionsCandidateDraft[] = [];
  const notes: string[] = [];
  const byMonth = new Map<string, DeductionsCandidateDraft[]>();
  for (const draft of input.drafts) {
    const identity = input.identityOf(draft);
    if (identity && ownMonthIdentities.has(`${draft.monthKey}\u0000${identity}`)) {
      keep.push(draft);
      continue;
    }
    const group = byMonth.get(draft.monthKey) ?? [];
    group.push(draft);
    byMonth.set(draft.monthKey, group);
  }
  for (const [monthKey, drafts] of byMonth) {
    const otherMonths = input.live
      .filter((row) => row.monthKey !== monthKey)
      .map((row) => ({
        employeeHrIdCompact: row.employeeHrIdCompact,
        category: row.category,
        sourceSystem: row.sourceSystem,
        dates: row.dates ?? [],
      }));
    const split = splitDraftsByClaimedDays(drafts, otherMonths);
    keep.push(...split.keep);
    for (const { draft, claimedDates, openDates } of split.held) {
      const who = draft.employeeName?.trim() || "An employee";
      notes.push(
        `${who}: ${claimedDates.join(", ")} already sit on a deduction of another payroll month (the other collection cycle), ` +
          `so this finding was held back, not added` +
          (openDates.length ? `. Days it also found that are not charged yet: ${openDates.join(", ")} — add them by hand if they stand.` : "."),
      );
    }
  }
  return { keep, notes };
}

/**
 * The live rows the cross-cycle hold reads: the month before, the month and the month after, for every
 * category the drafts carry. Throws on a failed read, so the connector fails before any write.
 */
async function applyCrossCycleHold(
  drafts: DeductionsCandidateDraft[],
  period: PayrollMonth,
): Promise<{ drafts: DeductionsCandidateDraft[]; notes: string[] }> {
  if (drafts.length === 0) return { drafts, notes: [] };
  const months = [shiftMonth(period, -1), period, shiftMonth(period, 1)].map(monthKeyOf);
  const categories = [...new Set(drafts.map((draft) => draft.category))];
  const live: CrossCycleLiveRow[] = [];
  for (const monthKey of months) {
    for (const category of categories) {
      live.push(...(await listCandidatesForMonth({ monthKey, category })));
    }
  }
  const held = holdCrossCycleClaimedDrafts({
    drafts,
    live,
    identityOf: (draft) => {
      try {
        return deductionsCandidateIdentityKey(prepareCandidateInsertPayload(draft, { createdBy: "system" }).candidate_key);
      } catch {
        return null;
      }
    },
  });
  return { drafts: held.keep, notes: held.notes };
}

/**
 * THE HEAD OFFICE CYCLE (owner, 2026-10-26): one connector, one payroll month, the one-part
 * employees only, judged over the 22nd of the previous month → the 21st (1 → 21 October for the
 * first, October 2026, payroll month — September was collected on the calendar month for everyone).
 *
 * The connectors are built for a calendar month, so the window is assembled from them: the connector
 * runs for EVERY calendar month the window touches, its drafts are kept for the one-part employees,
 * clipped to the window, re-keyed to the payroll month and merged where one record spans both months.
 * The month in progress is fine to read — every day after the window's end is clipped away, and the
 * window itself must have ENDED in Cairo before anything runs (the same rule as the calendar guard,
 * drawn at the 21st instead of the month's last day).
 *
 * Any connector run that throws fails the whole window BEFORE a write, so a half-read window can
 * never be reconciled as "the source retracted the rest".
 */
async function collectOneConnectorForOfficeCycle(
  input: CollectorInput & { connector: DeductionCollectorKey; collector: Collector },
): Promise<CandidateDraftInsertResult> {
  const { collector, createdBy } = input;
  const period = { month: input.month, year: input.year };
  // Throws for a payroll month before October 2026 — there is no office window there.
  const window = cycleWindow("office", period);
  const today = cairoTodayIso();
  if (!isCycleWindowCollectable(window, today)) {
    throw new Error(
      `Validation: the Head Office cycle for ${calendarMonthLabel(period)} (${cycleWindowLabel(window)}) has not finished — ` +
        `it can be collected from the day after ${window.end}. Today is ${today} in Cairo. Collecting an unfinished window ` +
        `charges people for days that have not ended, and CRM candidates publish without an approval step.`,
    );
  }

  try {
    const onePart = await loadOnePartEmployeeCompacts();
    const employeeFilter = (compact: string) => cycleCoversEmployee("office", period, onePart.has(compact));

    const clipped: DeductionsCandidateDraft[] = [];
    const notes: string[] = [];
    const cutoverNotes: string[] = [];
    for (const calendarMonth of calendarMonthsInWindow(window)) {
      const output = await collector.run({ ...calendarMonth, createdBy });
      const parts = collectorOutputParts(output);
      const label = calendarMonthLabel(calendarMonth);
      for (const note of parts.notes) notes.push(`${label}: ${note}`);
      for (const draft of parts.drafts) {
        if (!employeeFilter(compactDeductionsHrId(draft.employeeHrId) ?? "")) continue;
        const kept = clipDraftToCycleWindow(draft, window, monthKeyOf(calendarMonth));
        if (kept) clipped.push(kept);
      }
      if (collector.key === "crm") {
        const noted = await withCrmCutoverMonthNote({ created: 0, skippedExisting: 0, warnings: [] }, calendarMonth);
        cutoverNotes.push(...noted.warnings);
      }
    }
    const merged = mergeCycleDrafts(clipped);
    notes.push(...merged.notes, ...cutoverNotes);
    // People the owner took out of every deduction type — dropped before reconciling, as on the
    // calendar path, so a re-run retires their still-live rows.
    const { kept: unheld } = dropDeductionExemptDrafts(merged.drafts);
    // A day already on the CALENDAR cycle's row (a payment-mode change between runs, or an older row)
    // is never added again.
    const crossCycle = await applyCrossCycleHold(unheld, period);
    // A day won on a released daily deduction's dispute is never charged again — as on the calendar path.
    const spared = await applyAcceptedDailyDisputes(crossCycle.drafts);
    const drafts = spared.drafts;
    notes.push(...crossCycle.notes, ...spared.notes);
    const withNotes = (result: CandidateDraftInsertResult): CandidateDraftInsertResult =>
      notes.length === 0 ? result : { ...result, warnings: [...result.warnings, ...notes] };

    const sourceLabel = `${collector.label} — Head Office cycle (${cycleWindowLabel(window)})`;
    if (collector.reconcilesWholeCategory) {
      return withNotes(await reconcileCandidateDrafts({
        createdBy,
        drafts,
        scope: {
          category: collector.reconcilesWholeCategory,
          monthKey: window.monthKey,
          employeeFilter,
          dateWindow: { start: window.start, end: window.end },
        },
        sourceLabel,
      }));
    }
    if (collector.reconcilesSourceScope) {
      return withNotes(await reconcileCandidateDrafts({
        createdBy,
        drafts,
        scope: {
          category: collector.reconcilesSourceScope.category,
          monthKey: window.monthKey,
          sourceSystems: collector.reconcilesSourceScope.sourceSystems,
          employeeFilter,
          dateWindow: { start: window.start, end: window.end },
        },
        sourceLabel,
      }));
    }
    return withNotes(await insertCandidateDrafts({ createdBy, drafts, sourceLabel }));
  } catch (error) {
    return {
      created: 0,
      skippedExisting: 0,
      warnings: [`${collector.label} (Head Office cycle): connector failed: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

/**
 * Runs every automated connector for one month, sequentially.
 *
 * NOT safe to call from an HTTP request handler — the five company-wide scans
 * together exceed the 300s Cloud Run request limit on production-sized data.
 * This exists for server-side batch callers that have no request deadline;
 * anything request-bound must step through `DEDUCTION_COLLECTORS` with
 * `collectOneConnectorForMonth` instead.
 */
export async function collectAllCandidatesForMonth(input: CollectorInput): Promise<MonthlyCollectionResult> {
  const results = {} as MonthlyCollectionResult;
  for (const collector of DEDUCTION_COLLECTORS) {
    results[collector.key] = await collectOneConnectorForMonth({ ...input, connector: collector.key });
  }
  return results;
}
