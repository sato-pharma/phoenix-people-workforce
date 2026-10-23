import { addDaysIso } from "@/lib/crm/dates";
import { canonicalHrIdForDisplay, canonicalHrIdKey, hrIdLookupKeys } from "@/lib/hr-id";
import type { getSupabaseAdmin } from "@/lib/supabase/server";
import {
  calendarVerdict,
  callRateToFor,
  countsOnFieldVisitChip,
  DOOR_COLUMNS,
  evaluateRepDay,
  isRowOfRep,
  kpiApplicability,
  kpiExpectation,
  lifecycleCorrelationId,
  monthOf,
  type DoorRow,
  type KpiExpectation,
  type KpiMonth,
  type PersonFacts,
  type RepDayVerdict,
  type SavedVisit,
  type StageFailure,
  type StartedSeatWindow,
} from "@/lib/system-audit/detectors/visit-lifecycle-expected";
import { resolveSidebarLabel } from "@/lib/system-audit/sidebar-label";
import {
  emptyDetectorResult,
  SILENT_DATA_MESSAGE,
  type AuditDetector,
  type AuditIssueInput,
  type AuditOccurrenceInput,
  type DetectorContext,
  type DetectorResult,
  type ModuleLabelSource,
  type RootCauseLevel,
  type ShellKind,
} from "@/lib/system-audit/types";

/**
 * The `visit_lifecycle` detector — Phoenix CRM visits that were saved and never carried through.
 *
 * A saved visit has to pass the countable set (S1), the unified view (S2) and the read door (S3)
 * before the Private Calendar (S4) or the KPIs call rate (S5) can show it. For every rep-day whose
 * visits changed, this detector reads what each door actually holds — through the doors themselves,
 * never around them — and hands it to visit-lifecycle-expected.ts, which states every business rule
 * that DELIBERATELY keeps a visit out. A visit a rule left out is counted on the run and is never a
 * finding; a visit that should have arrived and did not is.
 *
 * ONE LOST VISIT COUNTS ONCE. A rep-day writes one root row, at the first stage that lost visits,
 * with every later stage in its evidence. The consumers that miss those visits because of it — the
 * calendar, the call rate — write rows that are NOT root symptoms and carry the root's correlation
 * id. A consumer that loses visits on its own writes its own root.
 *
 * NOTHING IS GUESSED. A door that could not be read writes an UNKNOWN row for the visits it would
 * have judged, never a pass and never a loss.
 *
 * 🔴 READ-ONLY. It never writes a visit, an approval, a KPI or a calendar row, and never asks a door
 * to behave differently: a rule here that disagrees with the database is a finding for a person.
 *
 * THE WATERMARK. Cron runs read every visit fact touched since the cursor (saves, approvals,
 * recordings, removals, edits), judge only the rep-days quiet for two hours, and write the cursor
 * with each batch's rows. The call rate is judged per rep-month, from a queue the cursor carries.
 * A historical run walks a Cairo date window and never moves the cron watermark.
 */

type Client = ReturnType<typeof getSupabaseAdmin>;

export const VISIT_LIFECYCLE_DETECTOR_ID = "visit_lifecycle";
const DETECTOR_VERSION = 1;
/** A rep-day touched more recently than this may still be in motion (an approval, a re-save). */
const QUIET_MS = 2 * 60 * 60 * 1000;
/** Where a cron run with no watermark starts. */
const DEFAULT_LOOKBACK_MS = 48 * 60 * 60 * 1000;
const DEFAULT_BATCH = 40;
const DEFAULT_KPI_PER_RUN = 30;
/** Rep-months waiting for a call-rate check; the oldest beyond this are dropped AND counted. */
const KPI_QUEUE_CAP = 600;
const EVIDENCE_IDS = 20;
const EVIDENCE_BYTES = 4_000;
/**
 * The read door answers `[]` for a view it cannot find (lead R6). A whole batch where both reads came
 * back empty while at least this many visits should have been there is reported as unread, not lost.
 */
const EMPTY_DOOR_FLOOR = 5;
const EMPTY_DOOR_SOURCE = "crm_visits_unified (answered no row for the whole batch)";
const RELATED_TABLE = "phoenix_crm_visits";
const REP_ROLE = "Medical Rep";

// ── The ports: every read the detector makes, so the tests can hand in a world ─────────────────────

/** One rep-day with something new, and the hr ids its rows were written under (casing varies). */
export type RepDayTouch = { hrKey: string; hrIds: string[]; date: string; lastTouchAt: string };

export type DoorReadInput = { hrIds: string[]; crmIds: number[]; dateFrom: string; dateTo: string; visitDates: string[] };

export type CalendarDayReading = { readable: true; phoenix: number } | { readable: false; sources: string[] };

export interface VisitLifecyclePorts {
  /** Cron: rep-days with a visit fact changed in (after, until]. */
  readTouchedRepDays(input: { after: string; until: string }): Promise<RepDayTouch[]>;
  /** Historical: rep-days with a real saved visit in the Cairo window. */
  listRepDays(window: { from: string; to: string }): Promise<RepDayTouch[]>;
  /** S0 — every `phoenix_crm_visits` row of these reps on these days, tests included, with its facts. */
  readSavedVisits(input: { hrIds: string[]; dates: string[] }): Promise<SavedVisit[]>;
  /** S1 — which of these ids `phoenix_crm_countable_visits` holds. */
  readCountableIds(ids: string[]): Promise<Set<string>>;
  /** S2 — `phoenix_crm_started_team_seats()`. */
  readStartedTeamSeats(): Promise<StartedSeatWindow[]>;
  /** S2 — the Phoenix rows of `crm_visits_unified` among `ids`, asked WITHOUT the departed exclusion. */
  readUnifiedRows(input: DoorReadInput & { ids: string[] }): Promise<DoorRow[]>;
  /** S3 — what the read door serves for these people and days, before any collapse. */
  readDoorVisits(input: DoorReadInput): Promise<DoorRow[]>;
  readExcludedAgentCrmIds(): Promise<number[]>;
  readPeople(): Promise<PersonFacts[]>;
  /** S4 — the Phoenix count on each day's field-visit chip, keyed `${hrKey}|${date}`. */
  readCalendarDays(days: Array<{ hrId: string; date: string }>): Promise<Map<string, CalendarDayReading>>;
  /** S5 — what the KPIs board counts for one rep-month, every call-rate lane added up. */
  readKpiTotal(input: { person: PersonFacts; month: KpiMonth; callRateTo: string; today: string }): Promise<{ total: number; holidaysComplete: boolean }>;
  readHolidays(month: KpiMonth): Promise<{ complete: boolean; dates: ReadonlySet<string> }>;
}

// ── What each finding is called ────────────────────────────────────────────────────────────────────

export type Consumer = "phoenix_crm" | "private_calendar" | "kpis";

/** The page each consumer is, in a medical rep's sidebar. The fallback is used only when no row matches. */
const CONSUMER_PAGES: Record<Consumer, { route: string; fallback: string }> = {
  phoenix_crm: { route: "/employee-portals/field-crm", fallback: "Phoenix CRM" },
  private_calendar: { route: "/employee-portals/private-calendar", fallback: "Private Calendar" },
  kpis: { route: "/employee-portals/kpis/call-rate", fallback: "Call Rate" },
};

export type FindingKind =
  | "s1"
  | "s1-no_approval"
  | "s1-extra"
  | "s2"
  | "s3"
  | "s3-departed"
  | "s3-merged"
  | "s3-vendor"
  | "s4-linked"
  | "s4-own"
  | "s4-extra"
  | "s5-linked"
  | "s5-month"
  | "s1-unreadable"
  | "s2-unreadable"
  | "s3-unreadable"
  | "s4-unreadable"
  | "s5-unreadable";

type FindingSpec = {
  signature: string;
  errorCode: string;
  title: string;
  consumer: Consumer;
  rootCauseLevel: RootCauseLevel;
  rootCause: string | null;
  unreadable?: boolean;
};

/**
 * Every finding's issue. A consumer's linked rows and its own losses share ONE signature — they are the
 * same symptom on the same screen — and `isRootSymptom` tells them apart.
 */
export const VISIT_LIFECYCLE_FINDINGS: Record<FindingKind, FindingSpec> = {
  s1: {
    signature: "visit:s1:countable",
    errorCode: "VISIT-S1-MISSING",
    title: "Saved visit missing from the countable visits",
    consumer: "phoenix_crm",
    rootCauseLevel: "unknown",
    rootCause: null,
  },
  "s1-no_approval": {
    signature: "visit:s1:countable:no_approval",
    errorCode: "VISIT-S1-NOAPPROVAL",
    title: "Off-plan visit saved without its approval request — it can never count",
    consumer: "phoenix_crm",
    rootCauseLevel: "confirmed",
    rootCause: "The visit was saved off-plan with no approval row, and the countable rule waits for an approval that can never be given.",
  },
  "s1-extra": {
    signature: "visit:s1:countable:extra",
    errorCode: "VISIT-S1-EXTRA",
    title: "Visit counted before its approval or its recording review",
    consumer: "phoenix_crm",
    rootCauseLevel: "unknown",
    rootCause: null,
  },
  s2: {
    signature: "visit:s2:unified",
    errorCode: "VISIT-S2-MISSING",
    title: "Countable visit missing from the CRM visits view",
    consumer: "phoenix_crm",
    rootCauseLevel: "unknown",
    rootCause: null,
  },
  s3: {
    signature: "visit:s3:reader",
    errorCode: "VISIT-S3-MISSING",
    title: "Visit missing from the CRM read door",
    consumer: "phoenix_crm",
    rootCauseLevel: "unknown",
    rootCause: null,
  },
  "s3-departed": {
    signature: "visit:s3:reader:departed",
    errorCode: "VISIT-S3-DEPARTED",
    title: "An employed rep's visits hidden as a departed agent's",
    consumer: "phoenix_crm",
    rootCauseLevel: "probable",
    rootCause: "The rep's CRM account is on the departed-agent exclusion while the rep is still employed.",
  },
  "s3-merged": {
    signature: "visit:s3:reader:merged",
    errorCode: "VISIT-S3-MERGED",
    title: "Visits to two different customers folded into one",
    consumer: "phoenix_crm",
    rootCauseLevel: "probable",
    rootCause: "Two different customers carry the same CRM contact id, so the duplicate collapse reads them as one stop.",
  },
  "s3-vendor": {
    signature: "visit:s3:reader:vendor",
    errorCode: "VISIT-S3-VENDOR",
    title: "iReports360 visits served beside the rep's Phoenix CRM day",
    consumer: "phoenix_crm",
    rootCauseLevel: "probable",
    rootCause: "The read door served the rep's iReports360 rows on a day the rep logged in Phoenix CRM, so the day counts twice.",
  },
  "s4-linked": {
    signature: "visit:s4:private_calendar",
    errorCode: "VISIT-S4-MISSING",
    title: "Visit missing from the Private Calendar",
    consumer: "private_calendar",
    rootCauseLevel: "unknown",
    rootCause: null,
  },
  "s4-own": {
    signature: "visit:s4:private_calendar",
    errorCode: "VISIT-S4-MISSING",
    title: "Visit missing from the Private Calendar",
    consumer: "private_calendar",
    rootCauseLevel: "unknown",
    rootCause: null,
  },
  "s4-extra": {
    signature: "visit:s4:private_calendar:extra",
    errorCode: "VISIT-S4-EXTRA",
    title: "Visit counted twice on the Private Calendar",
    consumer: "private_calendar",
    rootCauseLevel: "unknown",
    rootCause: null,
  },
  "s5-linked": {
    signature: "visit:s5:kpis",
    errorCode: "VISIT-S5-MISSING",
    title: "Visits missing from the KPIs call rate",
    consumer: "kpis",
    rootCauseLevel: "unknown",
    rootCause: null,
  },
  "s5-month": {
    signature: "visit:s5:kpis",
    errorCode: "VISIT-S5-MISSING",
    title: "Visits missing from the KPIs call rate",
    consumer: "kpis",
    rootCauseLevel: "unknown",
    rootCause: null,
  },
  "s1-unreadable": {
    signature: "visit:s1:countable:unreadable",
    errorCode: "VISIT-S1-UNREADABLE",
    title: "Countable visits could not be read — visits not checked",
    consumer: "phoenix_crm",
    rootCauseLevel: "unknown",
    rootCause: null,
    unreadable: true,
  },
  "s2-unreadable": {
    signature: "visit:s2:unified:unreadable",
    errorCode: "VISIT-S2-UNREADABLE",
    title: "CRM visits view could not be read — visits not checked",
    consumer: "phoenix_crm",
    rootCauseLevel: "unknown",
    rootCause: null,
    unreadable: true,
  },
  "s3-unreadable": {
    signature: "visit:s3:reader:unreadable",
    errorCode: "VISIT-S3-UNREADABLE",
    title: "CRM read door could not be read — visits not checked",
    consumer: "phoenix_crm",
    rootCauseLevel: "unknown",
    rootCause: null,
    unreadable: true,
  },
  "s4-unreadable": {
    signature: "visit:s4:private_calendar:unreadable",
    errorCode: "VISIT-S4-UNREADABLE",
    title: "Private Calendar could not be read — visits not checked",
    consumer: "private_calendar",
    rootCauseLevel: "unknown",
    rootCause: null,
    unreadable: true,
  },
  "s5-unreadable": {
    signature: "visit:s5:kpis:unreadable",
    errorCode: "VISIT-S5-UNREADABLE",
    title: "KPIs call rate could not be checked — visits not checked",
    consumer: "kpis",
    rootCauseLevel: "unknown",
    rootCause: null,
    unreadable: true,
  },
};

/** One finding before it is dressed as a ledger row. Pure, so the tests read it directly. */
export type LifecycleFinding = {
  kind: FindingKind;
  hrKey: string;
  /** The visit day (or the month's first day for a month-level row). */
  date: string;
  correlationId: string | null;
  isRoot: boolean;
  ids: string[];
  technicalMessage: string;
  evidence: Record<string, unknown>;
  firstEventAt?: string | null;
};

function kindOf(failure: StageFailure): FindingKind {
  if (failure.stage === 1) return failure.kind === "no_approval" ? "s1-no_approval" : failure.kind === "extra" ? "s1-extra" : "s1";
  if (failure.stage === 2) return "s2";
  if (failure.kind === "departed") return "s3-departed";
  if (failure.kind === "merged") return "s3-merged";
  if (failure.kind === "vendor") return "s3-vendor";
  return "s3";
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function failureMessage(failure: StageFailure, date: string): string {
  const visits = plural(failure.ids.length, "visit");
  switch (kindOf(failure)) {
    case "s1-no_approval":
      return `${plural(failure.ids.length, "off-plan visit")} of ${date} saved without the approval row the save writes beside it — nothing can ever count them.`;
    case "s1-extra":
      return `${visits} of ${date} counted by phoenix_crm_countable_visits although a rule keeps them out (an approval or a recording review still pending).`;
    case "s1":
      return `${visits} of ${date} never reached phoenix_crm_countable_visits although every rule counts them (expected ${failure.expected}, found ${failure.found}).`;
    case "s2":
      return `${visits} of ${date} on a started team's seat missing from crm_visits_unified (expected ${failure.expected}, found ${failure.found}).`;
    case "s3-departed":
      return `${visits} of ${date} hidden by the departed-agent exclusion while the rep is still employed.`;
    case "s3-merged":
      return `${visits} of ${date} to a different customer folded into another stop by the duplicate collapse.`;
    case "s3-vendor":
      return `${plural(failure.ids.length, "iReports360 row")} served for ${date}, a day the rep logged in Phoenix CRM — the day counts twice.`;
    default:
      return `${visits} of ${date} the read door should serve were not returned by queryVisits (expected ${failure.expected}, found ${failure.found}).`;
  }
}

function stageBreakdown(failures: readonly StageFailure[]) {
  return failures.map((failure) => ({ stage: failure.stage, kind: failure.kind, expected: failure.expected, found: failure.found, visits: failure.ids.length }));
}

/**
 * The rows one rep-day writes: its root (the first stage that lost visits), its extras, what could not
 * be read, and the Private Calendar's verdict. `calendar` is undefined when the day was not asked of
 * the calendar (nothing on its chip); `doorReadable` false keeps the calendar's double-count check
 * quiet, since it is measured against what the door served.
 */
export function repDayFindings(day: RepDayVerdict, calendar: CalendarDayReading | undefined, doorReadable: boolean): LifecycleFinding[] {
  const findings: LifecycleFinding[] = [];
  const dayCorrelation = day.lostIds.length > 0 ? lifecycleCorrelationId(day.hrKey, day.date, day.lostIds) : null;
  const root = day.failures[0];
  if (root) {
    const lost = new Set(day.lostIds);
    findings.push({
      kind: kindOf(root),
      hrKey: day.hrKey,
      date: day.date,
      correlationId: dayCorrelation,
      isRoot: true,
      ids: day.lostIds,
      technicalMessage:
        day.failures.length > 1
          ? `${failureMessage(root, day.date)} Later stages: ${day.failures.slice(1).map((failure) => `S${failure.stage} ${failure.kind} ${failure.ids.length}`).join(", ")}.`
          : failureMessage(root, day.date),
      evidence: {
        stage: root.stage,
        kind: root.kind,
        expected: root.expected,
        found: root.found,
        stages: stageBreakdown(day.failures),
        excluded: day.excluded,
        // Lead R5: a visit captured between midnight and 2 am Cairo is where a reader slicing the clock in UTC loses it.
        capturedBefore2amCairo: day.earlyHoursIds.filter((id) => lost.has(id)),
      },
      firstEventAt: day.firstLostSavedAt,
    });
  }
  for (const extra of day.extras) {
    findings.push({
      kind: kindOf(extra),
      hrKey: day.hrKey,
      date: day.date,
      correlationId: lifecycleCorrelationId(day.hrKey, day.date, extra.ids, `s${extra.stage}-${extra.kind}`),
      isRoot: true,
      ids: extra.ids,
      technicalMessage: failureMessage(extra, day.date),
      evidence: { stage: extra.stage, kind: extra.kind, expected: extra.expected, found: extra.found },
    });
  }
  // One row per unread stage: two gaps at one stage (the door and the exclusion list) share it.
  const gaps = new Map<number, { sources: Set<string>; ids: Set<string> }>();
  for (const gap of day.unreadable) {
    const entry = gaps.get(gap.stage) ?? { sources: new Set<string>(), ids: new Set<string>() };
    for (const source of gap.sources) entry.sources.add(source);
    for (const id of gap.ids) entry.ids.add(id);
    gaps.set(gap.stage, entry);
  }
  for (const [stage, gap] of [...gaps.entries()].sort((left, right) => left[0] - right[0])) {
    const ids = [...gap.ids].sort();
    findings.push({
      kind: `s${stage}-unreadable` as FindingKind,
      hrKey: day.hrKey,
      date: day.date,
      correlationId: lifecycleCorrelationId(day.hrKey, day.date, ids, `s${stage}-unreadable`),
      isRoot: true,
      ids,
      technicalMessage: `${[...gap.sources].join(", ")} could not be read; ${plural(ids.length, "visit")} of ${day.date} not checked at stage ${stage}.`,
      evidence: { stage, unreadable: true, sources: [...gap.sources] },
    });
  }

  if (calendar === undefined) return findings;
  const verdict = calendarVerdict(day, calendar.readable ? calendar.phoenix : 0);
  if (!calendar.readable) {
    if (verdict.expected > 0) {
      findings.push({
        kind: "s4-unreadable",
        hrKey: day.hrKey,
        date: day.date,
        correlationId: lifecycleCorrelationId(day.hrKey, day.date, verdict.shouldIds, "s4-unreadable"),
        isRoot: true,
        ids: verdict.shouldIds,
        technicalMessage: `The Private Calendar (${calendar.sources.join(", ")}) could not be read; ${plural(verdict.expected, "visit")} of ${day.date} not checked.`,
        evidence: { stage: 4, unreadable: true, sources: calendar.sources, expected: verdict.expected },
      });
    }
    return findings;
  }
  const calendarEvidence = {
    stage: 4,
    expected: verdict.expected,
    found: verdict.found,
    served: verdict.served,
    lostUpstream: verdict.lostUpstream,
    partneredOnDoubleVisitFeed: verdict.excludedPartnered,
  };
  if (verdict.missing > 0) {
    const lost = new Set(day.lostIds);
    const linked = Math.min(verdict.missing, verdict.lostUpstream);
    const own = verdict.missing - linked;
    if (linked > 0 && dayCorrelation) {
      const ids = verdict.shouldIds.filter((id) => lost.has(id));
      findings.push({
        kind: "s4-linked",
        hrKey: day.hrKey,
        date: day.date,
        correlationId: dayCorrelation,
        isRoot: false,
        ids,
        technicalMessage: `${plural(linked, "visit")} of ${day.date} missing from the Private Calendar because ${linked === 1 ? "it was" : "they were"} lost before the read door (${root ? VISIT_LIFECYCLE_FINDINGS[kindOf(root)].signature : "upstream"}).`,
        evidence: { ...calendarEvidence, missing: linked },
      });
    }
    if (own > 0) {
      const ids = verdict.shouldIds.filter((id) => !lost.has(id));
      findings.push({
        kind: "s4-own",
        hrKey: day.hrKey,
        date: day.date,
        correlationId: lifecycleCorrelationId(day.hrKey, day.date, ids, "s4"),
        isRoot: true,
        ids,
        technicalMessage: `The Private Calendar shows ${verdict.found} of the ${verdict.expected} Phoenix CRM visits that should be on ${day.date}; ${plural(own, "visit")} lost at the calendar itself.`,
        evidence: { ...calendarEvidence, missing: own },
      });
    }
  }
  if (doorReadable && verdict.extra > 0) {
    findings.push({
      kind: "s4-extra",
      hrKey: day.hrKey,
      date: day.date,
      correlationId: lifecycleCorrelationId(day.hrKey, day.date, verdict.shouldIds, "s4-extra"),
      isRoot: true,
      ids: verdict.shouldIds,
      technicalMessage: `The Private Calendar counts ${verdict.found} Phoenix CRM visits on ${day.date}; the read door serves ${verdict.served} — ${plural(verdict.extra, "visit")} counted twice.`,
      evidence: { ...calendarEvidence, extra: verdict.extra },
    });
  }
  return findings;
}

/**
 * The call rate's rows for one rep-month. A shortfall is first explained by the visits lost upstream
 * — one linked row per day, on that day's correlation id — and only what is left is the call rate's
 * own root. Counting MORE than the rules allow is not judged: an iReports360 row the panel attributes
 * by CRM id alone would read as a false extra.
 */
export function kpiMonthFindings(input: {
  hrKey: string;
  month: KpiMonth;
  callRateTo: string;
  expectation: KpiExpectation;
  found: number;
  days: readonly RepDayVerdict[];
}): LifecycleFinding[] {
  const { hrKey, month, callRateTo, expectation, found } = input;
  const shortfall = expectation.min - found;
  if (shortfall <= 0) return [];
  const monthLabel = month.start.slice(0, 7);
  const base = { stage: 5, month: monthLabel, callRateTo, expected: { min: expectation.min, max: expectation.max }, found, shortfall };
  const findings: LifecycleFinding[] = [];
  const dayByDate = new Map(input.days.map((day) => [day.date, day]));
  let remaining = shortfall;
  for (const [date, ids] of [...expectation.lostByDay.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
    if (remaining <= 0) break;
    const day = dayByDate.get(date);
    if (!day || day.lostIds.length === 0) continue;
    const linked = Math.min(remaining, ids.length);
    remaining -= linked;
    findings.push({
      kind: "s5-linked",
      hrKey,
      date,
      correlationId: lifecycleCorrelationId(hrKey, date, day.lostIds),
      isRoot: false,
      ids: [...ids].sort(),
      technicalMessage: `${plural(linked, "visit")} of ${date} missing from the ${monthLabel} call rate because ${linked === 1 ? "it was" : "they were"} lost before the read door.`,
      evidence: { ...base, missing: linked },
    });
  }
  if (remaining > 0) {
    findings.push({
      kind: "s5-month",
      hrKey,
      date: month.start,
      correlationId: lifecycleCorrelationId(hrKey, month.start, [], "kpi-month"),
      isRoot: true,
      ids: [],
      technicalMessage: `The ${monthLabel} call rate counts ${found} visits through ${callRateTo}; the rules require at least ${expectation.min} — ${plural(remaining, "visit")} missing with no lost visit to explain ${remaining === 1 ? "it" : "them"}.`,
      evidence: { ...base, missing: remaining, excluded: expectation.excluded },
    });
  }
  return findings;
}

function kpiUnreadableFinding(hrKey: string, month: KpiMonth, sources: string[]): LifecycleFinding {
  return {
    kind: "s5-unreadable",
    hrKey,
    date: month.start,
    correlationId: lifecycleCorrelationId(hrKey, month.start, [], "s5-unreadable"),
    isRoot: true,
    ids: [],
    technicalMessage: `${sources.join(", ")} could not be read; the ${month.start.slice(0, 7)} call rate was not checked.`,
    evidence: { stage: 5, unreadable: true, sources, month: month.start.slice(0, 7) },
  };
}

// ── Dressing findings as ledger rows ───────────────────────────────────────────────────────────────

export type ModuleLabel = { label: string; source: ModuleLabelSource; shell: ShellKind | null; route: string };

function moduleLabelOf(consumer: Consumer): ModuleLabel {
  const page = CONSUMER_PAGES[consumer];
  const resolved = resolveSidebarLabel({ route: page.route, role: REP_ROLE });
  // Hard-coded, and said so, only when the sidebar has no row for the page.
  if (resolved.source === "none") return { label: page.fallback, source: "detector", shell: "portal", route: page.route };
  return { label: resolved.label, source: resolved.source, shell: resolved.shell ?? "portal", route: page.route };
}

function compactEvidence(evidence: Record<string, unknown>, ids: readonly string[]): Record<string, unknown> {
  const full: Record<string, unknown> = { ...evidence, visitIds: ids.slice(0, EVIDENCE_IDS), visitCount: ids.length };
  if (JSON.stringify(full).length <= EVIDENCE_BYTES) return full;
  // Kept under the cap by dropping the detail the page can rebuild, never the count.
  delete full.stages;
  delete full.excluded;
  return { ...full, visitIds: ids.slice(0, 5), trimmed: true };
}

/** The ledger rows for a set of findings. Pure: `labels` and `people` are handed in. */
export function lifecycleRows(input: {
  findings: readonly LifecycleFinding[];
  people: ReadonlyMap<string, PersonFacts> | null;
  runAt: string;
  labels: (consumer: Consumer) => ModuleLabel;
  /** The rep-day's newest change, by `${hrKey}|${date}` — the row's last-event time. */
  lastTouch?: ReadonlyMap<string, string>;
}): { issues: AuditIssueInput[]; occurrences: AuditOccurrenceInput[] } {
  const issues = new Map<string, AuditIssueInput>();
  const occurrences = new Map<string, AuditOccurrenceInput>();
  for (const finding of input.findings) {
    const spec = VISIT_LIFECYCLE_FINDINGS[finding.kind];
    const label = input.labels(spec.consumer);
    const dedupeKey = `visit:${finding.kind}:${spec.consumer}:${finding.hrKey}:${finding.date}`;
    // One key, one row per write: the ledger's upsert cannot touch a row twice in one statement.
    if (occurrences.has(dedupeKey)) continue;
    if (!issues.has(spec.signature)) {
      issues.set(spec.signature, {
        signatureKey: spec.signature,
        family: "visit_lifecycle",
        errorCode: spec.errorCode,
        title: spec.title,
        rootCauseLevel: spec.rootCauseLevel,
        rootCause: spec.rootCause,
        rootCauseEvidence: spec.rootCause ? { rule: spec.rootCause } : {},
        status: spec.unreadable ? "unknown" : undefined,
        firstSeenAt: input.runAt,
        lastSeenAt: input.runAt,
      });
    }
    const person = input.people?.get(finding.hrKey) ?? null;
    const lastTouch = input.lastTouch?.get(`${finding.hrKey}|${finding.date}`) ?? input.runAt;
    const firstEventAt = finding.firstEventAt && Date.parse(finding.firstEventAt) <= Date.parse(lastTouch) ? finding.firstEventAt : lastTouch;
    occurrences.set(dedupeKey, {
      dedupeKey,
      signatureKey: spec.signature,
      correlationId: finding.correlationId,
      isRootSymptom: finding.isRoot,
      hrKey: finding.hrKey,
      hrIdDisplay: canonicalHrIdForDisplay(person?.hrId ?? finding.hrKey),
      employeeName: person?.fullName ?? null,
      roleAtEvent: person?.jobTitle ?? null,
      moduleLabel: label.label,
      moduleLabelSource: label.source,
      shell: label.shell,
      route: label.route,
      occurredAt: input.runAt,
      occurredAtKind: "detected",
      affectedDate: finding.date,
      userMessage: SILENT_DATA_MESSAGE,
      isSilent: true,
      technicalMessage: finding.technicalMessage,
      errorCode: spec.errorCode,
      relatedTable: RELATED_TABLE,
      relatedId: finding.ids[0] ?? null,
      firstEventAt,
      lastEventAt: lastTouch,
      sourceRefs: finding.ids.slice(0, EVIDENCE_IDS),
      evidence: compactEvidence({ ...finding.evidence, correlation: finding.isRoot ? "root" : "linked" }, finding.ids),
    });
  }
  return { issues: [...issues.values()], occurrences: [...occurrences.values()] };
}

// ── Judging a set of rep-days ──────────────────────────────────────────────────────────────────────

type Shared = {
  today: string;
  quietCutoff: string;
  people: Map<string, PersonFacts> | null;
  windows: StartedSeatWindow[] | null;
  excluded: Set<number> | null;
};

type RepDayRef = { hrKey: string; hrIds: string[]; date: string };

type JudgedDays = {
  days: Array<{ ref: RepDayRef; verdict: RepDayVerdict }>;
  doorRows: DoorRow[] | null;
  saved: SavedVisit[];
};

function unique<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}

/**
 * S0–S3 for a set of rep-days, every door read once for the whole set. A failed S0 read THROWS (the
 * run stops and its watermark stays where it was); a failed door read is unreadable for the visits it
 * would have judged.
 */
async function judgeRepDays(ports: VisitLifecyclePorts, shared: Shared, wanted: readonly RepDayRef[], unreadable: Set<string>): Promise<JudgedDays> {
  const hrIds = unique(
    wanted.flatMap((ref) => [...ref.hrIds, shared.people?.get(ref.hrKey)?.hrId ?? null]).filter((value): value is string => Boolean(value)),
  );
  const dates = unique(wanted.map((ref) => ref.date)).sort();
  const saved = await ports.readSavedVisits({ hrIds, dates });
  const wantedKeys = new Set(wanted.map((ref) => `${ref.hrKey}|${ref.date}`));
  const byKey = new Map<string, SavedVisit[]>();
  for (const visit of saved) {
    const key = `${canonicalHrIdKey(visit.repHrId)}|${visit.visitDate}`;
    if (!wantedKeys.has(key)) continue;
    byKey.set(key, [...(byKey.get(key) ?? []), visit]);
  }
  const candidates = [...byKey.values()].flat().filter((visit) => !visit.isTest && !visit.removed).map((visit) => visit.id);
  const crmIds = unique(
    wanted.map((ref) => shared.people?.get(ref.hrKey)?.crmId ?? null).filter((value): value is number => value != null),
  );
  const door: DoorReadInput = { hrIds, crmIds, dateFrom: dates[0], dateTo: dates[dates.length - 1], visitDates: dates };

  let countableIds: Set<string> | null = new Set();
  let unifiedRows: DoorRow[] | null = [];
  if (candidates.length > 0) {
    try {
      countableIds = await ports.readCountableIds(candidates);
    } catch {
      countableIds = null;
      unreadable.add("phoenix_crm_countable_visits");
    }
    try {
      unifiedRows = await ports.readUnifiedRows({ ...door, ids: candidates });
    } catch {
      unifiedRows = null;
      unreadable.add("crm_visits_unified");
    }
  }
  let doorRows: DoorRow[] | null;
  try {
    doorRows = await ports.readDoorVisits(door);
  } catch {
    doorRows = null;
    unreadable.add("crm_visits_unified via queryVisits");
  }

  const evaluate = (unified: DoorRow[] | null, served: DoorRow[] | null) =>
    wanted.map((ref) => ({
      ref,
      verdict: evaluateRepDay({
        hrKey: ref.hrKey,
        date: ref.date,
        today: shared.today,
        quietCutoff: shared.quietCutoff,
        person: shared.people?.get(ref.hrKey) ?? null,
        personReadable: shared.people !== null,
        saved: byKey.get(`${ref.hrKey}|${ref.date}`) ?? [],
        countableIds,
        windows: shared.windows,
        unifiedRows: unified,
        doorRows: served,
        excludedCrmIds: shared.excluded,
      }),
    }));
  let days = evaluate(unifiedRows, doorRows);
  const s2Missing = days.reduce((sum, day) => sum + (day.verdict.failures.find((failure) => failure.stage === 2)?.ids.length ?? 0), 0);
  if (unifiedRows !== null && unifiedRows.length === 0 && doorRows !== null && doorRows.length === 0 && s2Missing >= EMPTY_DOOR_FLOOR) {
    unreadable.add(EMPTY_DOOR_SOURCE);
    unifiedRows = null;
    doorRows = null;
    days = evaluate(null, null);
  }
  return { days, doorRows, saved: [...byKey.values()].flat() };
}

// ── The cursor ─────────────────────────────────────────────────────────────────────────────────────

export type VisitLifecycleCursor = { touchedAfter: string; kpiQueue: string[] };

function asCursor(value: Record<string, unknown> | null): VisitLifecycleCursor | null {
  if (!value || typeof value.touchedAfter !== "string" || Number.isNaN(Date.parse(value.touchedAfter))) return null;
  const queue = Array.isArray(value.kpiQueue) ? value.kpiQueue.filter((entry): entry is string => typeof entry === "string" && /^.+\|\d{4}-\d{2}$/.test(entry)) : [];
  return { touchedAfter: value.touchedAfter, kpiQueue: queue };
}

export function cairoDateOf(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

function bumpAll(target: Record<string, number>, counts: Record<string, number | undefined>): void {
  for (const [reason, count] of Object.entries(counts)) {
    if (count) target[reason] = (target[reason] ?? 0) + count;
  }
}

export type VisitLifecycleDependencies = {
  ports: VisitLifecyclePorts;
  /** Rep-days judged and written per call. */
  batchSize?: number;
  /** Rep-months whose call rate a cron run checks. */
  kpiPerRun?: number;
  /** Defaults to the context's clock. */
  now?: () => number;
  /** Labels, overridable for a test that must not depend on the sidebar. */
  labels?: (consumer: Consumer) => ModuleLabel;
};

export function createVisitLifecycleDetector(deps: VisitLifecycleDependencies): AuditDetector {
  const batchSize = Math.max(1, deps.batchSize ?? DEFAULT_BATCH);
  const kpiPerRun = Math.max(0, deps.kpiPerRun ?? DEFAULT_KPI_PER_RUN);
  return {
    id: VISIT_LIFECYCLE_DETECTOR_ID,
    family: "visit_lifecycle",
    version: DETECTOR_VERSION,
    async run(ctx: DetectorContext): Promise<DetectorResult> {
      const result = emptyDetectorResult();
      const ports = deps.ports;
      const clock = deps.now ?? ctx.now;
      const startedAt = clock();
      const runAt = new Date(startedAt).toISOString();
      const cutoffMs = startedAt - QUIET_MS;
      const quietCutoff = new Date(cutoffMs).toISOString();
      const today = cairoDateOf(startedAt);
      const historical = ctx.mode === "historical";
      const labelCache = new Map<Consumer, ModuleLabel>();
      const labels = (consumer: Consumer) => {
        const cached = labelCache.get(consumer);
        if (cached) return cached;
        const label = (deps.labels ?? moduleLabelOf)(consumer);
        labelCache.set(consumer, label);
        return label;
      };
      const unreadable = new Set<string>();
      const report = {
        today,
        quietCutoff,
        window: ctx.window ?? null,
        repDaysTouched: 0,
        repDaysJudged: 0,
        visitsChecked: 0,
        findings: 0,
        linkedRows: 0,
        kpiMonthsChecked: 0,
        kpiQueued: 0,
      };
      // Which step was running, so a failure names the source — and a failed WRITE is never
      // reported as an unreadable source.
      let stage: string | null = "system_audit_watermarks";
      let kpiQueue: string[] = [];
      let touchedAfter = "";

      const queueKpi = (hrKey: string, date: string) => {
        const entry = `${hrKey}|${date.slice(0, 7)}`;
        if (kpiQueue.includes(entry)) return;
        kpiQueue.push(entry);
        if (kpiQueue.length > KPI_QUEUE_CAP) {
          kpiQueue = kpiQueue.slice(kpiQueue.length - KPI_QUEUE_CAP);
          result.excludedCounts.kpi_queue_overflow = (result.excludedCounts.kpi_queue_overflow ?? 0) + 1;
        }
      };
      const write = async (findings: LifecycleFinding[], people: Map<string, PersonFacts> | null, lastTouch?: Map<string, string>) => {
        const rows = lifecycleRows({ findings, people, runAt, labels, lastTouch });
        stage = null;
        const written = await ctx.sink.write(VISIT_LIFECYCLE_DETECTOR_ID, ctx.runId, {
          issues: rows.issues,
          occurrences: rows.occurrences,
          merge: "max",
          // A historical run never moves the cron watermark.
          cursor: historical ? null : { touchedAfter, kpiQueue: [...kpiQueue] },
        });
        result.inserted += written.inserted;
        result.updated += written.updated;
        report.findings += rows.occurrences.length;
        report.linkedRows += rows.occurrences.filter((row) => row.isRootSymptom === false).length;
      };

      try {
        if (historical && !ctx.window) throw new Error("A historical visit-lifecycle run needs a Cairo date window.");
        const cursor = historical ? null : asCursor(await ctx.sink.readCursor(VISIT_LIFECYCLE_DETECTOR_ID));
        touchedAfter = cursor?.touchedAfter ?? new Date(startedAt - DEFAULT_LOOKBACK_MS).toISOString();
        kpiQueue = [...(cursor?.kpiQueue ?? [])];
        result.watermarkFrom = historical ? { window: ctx.window } : { touchedAfter, kpiQueued: kpiQueue.length };
        result.watermarkTo = result.watermarkFrom;

        stage = historical ? "phoenix_crm_visits" : "phoenix_crm_visits and its approval, recording, removal and edit rows";
        const touched = historical && ctx.window ? await ports.listRepDays(ctx.window) : await ports.readTouchedRepDays({ after: touchedAfter, until: runAt });
        report.repDaysTouched = touched.length;
        const ready = touched.filter((day) => Date.parse(day.lastTouchAt) <= cutoffMs);
        const deferred = touched.length - ready.length;
        if (deferred > 0) result.excludedCounts.rep_day_not_quiet = deferred;
        ready.sort((left, right) =>
          historical
            ? left.date.localeCompare(right.date) || left.hrKey.localeCompare(right.hrKey)
            : Date.parse(left.lastTouchAt) - Date.parse(right.lastTouchAt) || left.hrKey.localeCompare(right.hrKey) || left.date.localeCompare(right.date),
        );

        // Shared reads. Each failure is UNKNOWN for what it would have judged, never fatal.
        stage = null;
        let people: Map<string, PersonFacts> | null = null;
        try {
          people = new Map((await ports.readPeople()).map((person) => [person.hrKey, person]));
        } catch {
          unreadable.add("employee directory");
        }
        let windows: StartedSeatWindow[] | null = null;
        try {
          windows = await ports.readStartedTeamSeats();
        } catch {
          unreadable.add("phoenix_crm_started_team_seats");
        }
        let excluded: Set<number> | null = null;
        try {
          excluded = new Set(await ports.readExcludedAgentCrmIds());
        } catch {
          unreadable.add("departed-agent exclusion");
        }
        const shared: Shared = { today, quietCutoff, people, windows, excluded };

        let index = 0;
        let lastDone: RepDayTouch | null = null;
        while (index < ready.length) {
          if (clock() >= ctx.deadline) {
            result.status = "budget_exhausted";
            break;
          }
          const batch = ready.slice(index, index + batchSize);
          stage = "phoenix_crm_visits and its approval, recording, removal and edit rows";
          const judged = await judgeRepDays(ports, shared, batch.map((day) => ({ hrKey: day.hrKey, hrIds: day.hrIds, date: day.date })), unreadable);

          // S4: each day with something on its chip, one calendar read for the batch.
          const askCalendar = judged.days.filter(({ verdict }) => verdict.should.size > 0 || verdict.doorPhoenixKept.length > 0);
          let calendar: Map<string, CalendarDayReading> | null = new Map();
          if (askCalendar.length > 0) {
            try {
              calendar = await ports.readCalendarDays(
                askCalendar.map(({ ref }) => ({ hrId: people?.get(ref.hrKey)?.hrId ?? ref.hrIds[0] ?? ref.hrKey, date: ref.date })),
              );
            } catch {
              calendar = null;
              unreadable.add("private calendar");
            }
          }
          const asked = new Set(askCalendar.map(({ ref }) => `${ref.hrKey}|${ref.date}`));
          const findings: LifecycleFinding[] = [];
          for (const { ref, verdict } of judged.days) {
            const key = `${ref.hrKey}|${ref.date}`;
            const reading: CalendarDayReading | undefined = !asked.has(key)
              ? undefined
              : calendar === null
                ? { readable: false, sources: ["private calendar"] }
                : (calendar.get(key) ?? { readable: false, sources: ["private calendar (the employee or the day did not resolve)"] });
            findings.push(...repDayFindings(verdict, reading, judged.doorRows !== null));
            bumpAll(result.excludedCounts, verdict.excluded);
            // A partnered visit sits on the Double Visit feed, not the field-visit chip: counted, not judged at S4.
            const partnered = reading === undefined ? 0 : [...verdict.should.values()].filter((row) => !countsOnFieldVisitChip(row)).length;
            if (partnered > 0) result.excludedCounts.partnered_double_feed = (result.excludedCounts.partnered_double_feed ?? 0) + partnered;
            report.visitsChecked += verdict.checked;
            if (verdict.checked > 0) queueKpi(ref.hrKey, ref.date);
          }
          result.scanned += batch.length;
          report.repDaysJudged += batch.length;
          index += batch.length;
          lastDone = batch[batch.length - 1];

          if (!historical) {
            // The cursor may pass only what is done: a rep-day tied with the last one's instant is
            // still to come, so the cursor stops one millisecond short of it and re-reads the tie.
            const next = ready[index];
            const lastAt = Date.parse(lastDone.lastTouchAt);
            touchedAfter = new Date(next && Date.parse(next.lastTouchAt) === lastAt ? lastAt - 1 : lastAt).toISOString();
          }
          await write(findings, people, new Map(batch.map((day) => [`${day.hrKey}|${day.date}`, day.lastTouchAt])));
          result.watermarkTo = historical
            ? { window: ctx.window, resumeAfter: `${lastDone.date}|${lastDone.hrKey}`, kpiPending: kpiQueue.length }
            : { touchedAfter, kpiQueued: kpiQueue.length };
        }

        if (result.status !== "budget_exhausted" && !historical) {
          // Every quiet rep-day is judged: the next run starts at the quiet line, where the deferred ones still sit.
          const quietLine = Date.parse(quietCutoff) > Date.parse(touchedAfter) ? quietCutoff : touchedAfter;
          if (quietLine !== touchedAfter) {
            touchedAfter = quietLine;
            await write([], people);
            result.watermarkTo = { touchedAfter, kpiQueued: kpiQueue.length };
          }
        }

        // S5 — one rep-month: every day of it through the call rate's last day, judged again, then
        // what the rules require against what the KPIs board counts.
        const checkKpiMonth = async (entry: string): Promise<LifecycleFinding[]> => {
          const split = entry.lastIndexOf("|");
          const hrKey = entry.slice(0, split);
          const month = monthOf(`${entry.slice(split + 1)}-01`);
          const callRateTo = callRateToFor(month, today);
          const note = (reason: string) => {
            result.excludedCounts[reason] = (result.excludedCounts[reason] ?? 0) + 1;
          };
          if (callRateTo < month.start) {
            note("kpi_no_day_over_yet");
            return [];
          }
          if (people === null) return [kpiUnreadableFinding(hrKey, month, ["employee directory"])];
          const person = people.get(hrKey);
          if (!person) {
            note("kpi_not_in_employee_directory");
            return [];
          }
          if (windows === null) return [kpiUnreadableFinding(hrKey, month, ["phoenix_crm_started_team_seats"])];

          const dates: string[] = [];
          for (let day = month.start; day <= callRateTo; day = addDaysIso(day, 1)) dates.push(day);
          stage = "phoenix_crm_visits and its approval, recording, removal and edit rows";
          const judged = await judgeRepDays(ports, shared, dates.map((date) => ({ hrKey, hrIds: [person.hrId], date })), unreadable);
          stage = null;
          const seatIds = unique(judged.saved.map((visit) => visit.seatId));
          const applies = kpiApplicability({ month, person, seatIds, windows });
          if (!applies.applies) {
            note(applies.reason);
            return [];
          }
          // A day that could not be judged leaves the month's expectation unknown, never lower.
          const gaps = new Set<string>();
          for (const { verdict } of judged.days) for (const gap of verdict.unreadable) for (const source of gap.sources) gaps.add(source);
          if (judged.doorRows === null) gaps.add("crm_visits_unified via queryVisits");
          let holidays: { complete: boolean; dates: ReadonlySet<string> } | null = null;
          try {
            holidays = await ports.readHolidays(month);
          } catch {
            holidays = null;
          }
          if (!holidays?.complete) gaps.add("national holiday calendar");
          if (gaps.size > 0 || !holidays || !judged.doorRows) return [kpiUnreadableFinding(hrKey, month, [...gaps])];

          const vendorRows = judged.doorRows
            .filter((row) => row.source !== "phoenix" && isRowOfRep(row, hrKey, person))
            .map((row) => ({ row, attributedByHrId: canonicalHrIdKey(row.agent_hr_id) === hrKey }));
          const verdicts = judged.days.map((day) => day.verdict);
          const expectation = kpiExpectation({ month, callRateTo, holidays: holidays.dates, days: verdicts, vendorRows });
          let kpi: { total: number; holidaysComplete: boolean };
          try {
            kpi = await ports.readKpiTotal({ person, month, callRateTo, today });
          } catch {
            unreadable.add("KPIs call rate (loadPhoenixRepKpis)");
            return [kpiUnreadableFinding(hrKey, month, ["KPIs call rate (loadPhoenixRepKpis)"])];
          }
          if (!kpi.holidaysComplete) return [kpiUnreadableFinding(hrKey, month, ["KPIs board holiday calendar"])];
          report.kpiMonthsChecked += 1;
          bumpAll(result.excludedCounts, expectation.excluded);
          return kpiMonthFindings({ hrKey, month, callRateTo, expectation, found: kpi.total, days: verdicts });
        };

        // The call rate, one rep-month at a time, oldest queued first. The entry leaves the queue in
        // the same write as its rows.
        let kpiChecked = 0;
        while (result.status !== "budget_exhausted" && kpiQueue.length > 0 && (historical || kpiChecked < kpiPerRun)) {
          if (clock() >= ctx.deadline) {
            result.status = "budget_exhausted";
            break;
          }
          const findings = await checkKpiMonth(kpiQueue[0]);
          kpiQueue = kpiQueue.slice(1);
          kpiChecked += 1;
          await write(findings, people);
          result.watermarkTo = historical
            ? { window: ctx.window, resumeAfter: lastDone ? `${lastDone.date}|${lastDone.hrKey}` : null, kpiPending: kpiQueue.length }
            : { touchedAfter, kpiQueued: kpiQueue.length };
        }
      } catch (error) {
        result.status = "errored";
        result.error = error instanceof Error ? error.message : String(error);
        if (stage) unreadable.add(stage);
      }

      report.kpiQueued = kpiQueue.length;
      result.unreadableSources = [...unreadable];
      if (result.status === "ok" && unreadable.size > 0) result.status = "partial";
      result.report = report;
      return result;
    },
  };
}

// ── The production ports ───────────────────────────────────────────────────────────────────────────

const READ_PAGE = 1_000;
const ID_CHUNK = 100;
const CALENDAR_REPS_PER_CALL = 20;
const SAVED_COLUMNS =
  "id,seat_id,rep_hr_id,manager_hr_id,senior_hr_id,product_manager_hr_id,customer_id,list_type,visit_date,captured_at,created_at,is_test,is_unplanned,unplanned_kind";

type PostgrestAnswer = { data: unknown; error: { message?: string; code?: string } | null };

function readError(what: string, error: { message?: string; code?: string }): Error {
  return new Error(`Visit lifecycle ${what} read failed${error.code ? ` (${error.code})` : ""}: ${error.message ?? "unknown error"}`);
}

/** Every row of a read, in 1,000-row pages over a stable order. Throws on any error. */
async function readPaged<T>(what: string, page: (from: number, to: number) => PromiseLike<PostgrestAnswer>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += READ_PAGE) {
    const { data, error } = await page(from, from + READ_PAGE - 1);
    if (error) throw readError(what, error);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < READ_PAGE) return out;
    if (from >= 500 * READ_PAGE) throw new Error(`Visit lifecycle ${what} read did not finish within 500 pages.`);
  }
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < values.length; start += size) out.push(values.slice(start, start + size));
  return out;
}

function laterOf(...values: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  for (const value of values) {
    if (!value || Number.isNaN(Date.parse(value))) continue;
    if (best === null || Date.parse(value) > Date.parse(best)) best = value;
  }
  return best;
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

type VisitRow = {
  id: string;
  seat_id: string;
  rep_hr_id: string | null;
  manager_hr_id: string | null;
  senior_hr_id: string | null;
  product_manager_hr_id: string | null;
  customer_id: string;
  list_type: string | null;
  visit_date: string;
  captured_at: string | null;
  created_at: string;
  is_test: boolean;
  is_unplanned: boolean;
  unplanned_kind: string | null;
};

type TouchRow = { rep_hr_id: string | null; visit_date: string; at: string };

function groupTouches(rows: readonly TouchRow[]): RepDayTouch[] {
  const byKey = new Map<string, RepDayTouch>();
  for (const row of rows) {
    const hrKey = canonicalHrIdKey(row.rep_hr_id);
    if (!hrKey || !row.rep_hr_id || !row.visit_date) continue;
    const date = row.visit_date.slice(0, 10);
    const key = `${hrKey}|${date}`;
    const entry = byKey.get(key) ?? { hrKey, hrIds: [], date, lastTouchAt: row.at };
    if (!entry.hrIds.includes(row.rep_hr_id)) entry.hrIds.push(row.rep_hr_id);
    entry.lastTouchAt = laterOf(entry.lastTouchAt, row.at) ?? entry.lastTouchAt;
    byKey.set(key, entry);
  }
  return [...byKey.values()];
}

export function createDatabaseVisitLifecyclePorts(supabase: Client): VisitLifecyclePorts {
  /** The rep and day of visits named by id — for the facts that live beside a visit, not on it. */
  const visitsById = async (ids: readonly string[]) => {
    const out = new Map<string, { rep_hr_id: string | null; visit_date: string; is_test: boolean }>();
    for (const chunk of chunks(unique(ids), ID_CHUNK)) {
      const { data, error } = await supabase.from("phoenix_crm_visits").select("id,rep_hr_id,visit_date,is_test").in("id", chunk);
      if (error) throw readError("phoenix_crm_visits", error);
      for (const row of (data ?? []) as Array<{ id: string; rep_hr_id: string | null; visit_date: string; is_test: boolean }>) out.set(row.id, row);
    }
    return out;
  };

  return {
    async readTouchedRepDays({ after, until }) {
      const touches: TouchRow[] = [];
      const saves = await readPaged<{ rep_hr_id: string | null; visit_date: string; created_at: string }>("phoenix_crm_visits", (from, to) =>
        supabase
          .from("phoenix_crm_visits")
          .select("id,rep_hr_id,visit_date,created_at")
          .eq("is_test", false)
          .not("rep_hr_id", "is", null)
          .gt("created_at", after)
          .lte("created_at", until)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to),
      );
      for (const row of saves) touches.push({ rep_hr_id: row.rep_hr_id, visit_date: row.visit_date, at: row.created_at });

      // Facts kept beside the visit: an approval moving, a recording claimed, reviewed or deleted, an edit.
      const byVisit: Array<{ visit_id: string | null; at: string }> = [];
      // `tiebreak` is each table's own key, so the page order is total.
      const besides: Array<{ table: string; column: string; tiebreak: string }> = [
        { table: "phoenix_crm_unplanned_visits", column: "updated_at", tiebreak: "visit_id" },
        // phoenix_crm_visit_recordings is keyed by `path` (PRIMARY KEY (path)) and has no `id` column
        // at all, so ordering by one made the whole read fail 42703 and the detector with it.
        { table: "phoenix_crm_visit_recordings", column: "claimed_at", tiebreak: "path" },
        { table: "phoenix_crm_visit_recordings", column: "reviewed_at", tiebreak: "path" },
        { table: "phoenix_crm_visit_recordings", column: "deleted_at", tiebreak: "path" },
        { table: "phoenix_crm_visit_edits", column: "edited_at", tiebreak: "id" },
      ];
      for (const { table, column, tiebreak } of besides) {
        const rows = await readPaged<Record<string, string | null>>(table, (from, to) =>
          supabase
            .from(table)
            .select(`visit_id,${column}`)
            .not("visit_id", "is", null)
            .gt(column, after)
            .lte(column, until)
            .order(column, { ascending: true })
            .order(tiebreak, { ascending: true })
            .range(from, to),
        );
        for (const row of rows) if (row.visit_id && row[column]) byVisit.push({ visit_id: row.visit_id, at: row[column] as string });
      }
      const visits = await visitsById(byVisit.map((row) => row.visit_id as string));
      for (const row of byVisit) {
        const visit = visits.get(row.visit_id as string);
        if (visit && !visit.is_test) touches.push({ rep_hr_id: visit.rep_hr_id, visit_date: visit.visit_date, at: row.at });
      }

      // A removal: the visit row is gone, its copy keeps the rep and the day.
      const removals = await readPaged<{ rep_hr_id: string | null; visit_date: string; removed_at: string }>("phoenix_crm_removed_visits", (from, to) =>
        supabase
          .from("phoenix_crm_removed_visits")
          .select("visit_id,rep_hr_id,visit_date,removed_at")
          .eq("is_test", false)
          .gt("removed_at", after)
          .lte("removed_at", until)
          .order("removed_at", { ascending: true })
          .order("visit_id", { ascending: true })
          .range(from, to),
      );
      for (const row of removals) touches.push({ rep_hr_id: row.rep_hr_id, visit_date: row.visit_date, at: row.removed_at });
      return groupTouches(touches);
    },

    async listRepDays({ from: fromDate, to: toDate }) {
      const rows = await readPaged<{ rep_hr_id: string | null; visit_date: string; created_at: string }>("phoenix_crm_visits", (from, to) =>
        supabase
          .from("phoenix_crm_visits")
          .select("id,rep_hr_id,visit_date,created_at")
          .eq("is_test", false)
          .not("rep_hr_id", "is", null)
          .gte("visit_date", fromDate)
          .lte("visit_date", toDate)
          .order("id", { ascending: true })
          .range(from, to),
      );
      return groupTouches(rows.map((row) => ({ rep_hr_id: row.rep_hr_id, visit_date: row.visit_date, at: row.created_at })));
    },

    async readSavedVisits({ hrIds, dates }) {
      const variants = unique(hrIds.flatMap((hrId) => hrIdLookupKeys(hrId))).filter(Boolean);
      if (variants.length === 0 || dates.length === 0) return [];
      const visits = await readPaged<VisitRow>("phoenix_crm_visits", (from, to) =>
        supabase
          .from("phoenix_crm_visits")
          .select(SAVED_COLUMNS)
          .in("rep_hr_id", variants)
          .in("visit_date", [...dates])
          .order("id", { ascending: true })
          .range(from, to),
      );
      const ids = visits.map((visit) => visit.id);
      const unplanned = new Map<string, { status: string | null; updated_at: string | null }>();
      const recordings = new Map<string, Array<{ review_status: string | null; claimed_at: string | null; reviewed_at: string | null; deleted_at: string | null }>>();
      const removed = new Map<string, string>();
      const edits = new Map<string, string>();
      for (const chunk of chunks(ids, ID_CHUNK)) {
        const [unplannedRows, recordingRows, removedRows, editRows] = await Promise.all([
          readPaged<{ visit_id: string; status: string | null; updated_at: string | null }>("phoenix_crm_unplanned_visits", (from, to) =>
            supabase.from("phoenix_crm_unplanned_visits").select("visit_id,status,updated_at").in("visit_id", chunk).order("visit_id").range(from, to),
          ),
          // Every recording, deleted ones included: the countable view's NOT EXISTS reads them all.
          readPaged<{ visit_id: string; review_status: string | null; claimed_at: string | null; reviewed_at: string | null; deleted_at: string | null }>(
            "phoenix_crm_visit_recordings",
            (from, to) =>
              supabase
                .from("phoenix_crm_visit_recordings")
                .select("visit_id,review_status,claimed_at,reviewed_at,deleted_at")
                .in("visit_id", chunk)
                .order("path")
                .range(from, to),
          ),
          readPaged<{ visit_id: string; removed_at: string }>("phoenix_crm_removed_visits", (from, to) =>
            supabase.from("phoenix_crm_removed_visits").select("visit_id,removed_at").in("visit_id", chunk).order("visit_id").range(from, to),
          ),
          readPaged<{ visit_id: string; edited_at: string }>("phoenix_crm_visit_edits", (from, to) =>
            supabase.from("phoenix_crm_visit_edits").select("id,visit_id,edited_at").in("visit_id", chunk).order("id").range(from, to),
          ),
        ]);
        for (const row of unplannedRows) unplanned.set(row.visit_id, row);
        for (const row of recordingRows) recordings.set(row.visit_id, [...(recordings.get(row.visit_id) ?? []), row]);
        for (const row of removedRows) removed.set(row.visit_id, row.removed_at);
        for (const row of editRows) edits.set(row.visit_id, laterOf(edits.get(row.visit_id), row.edited_at) ?? row.edited_at);
      }
      const customers = new Map<string, { validated_at: string | null; list_type: string | null; reference_contact_crm_id: unknown; own_contact_crm_id: unknown }>();
      for (const chunk of chunks(unique(visits.map((visit) => visit.customer_id).filter(Boolean)), ID_CHUNK)) {
        const { data, error } = await supabase
          .from("phoenix_crm_customers")
          .select("id,validated_at,list_type,reference_contact_crm_id,own_contact_crm_id")
          .in("id", chunk);
        if (error) throw readError("phoenix_crm_customers", error);
        for (const row of (data ?? []) as Array<{ id: string; validated_at: string | null; list_type: string | null; reference_contact_crm_id: unknown; own_contact_crm_id: unknown }>) {
          customers.set(row.id, row);
        }
      }
      return visits.map((visit) => {
        const approval = unplanned.get(visit.id) ?? null;
        const claimed = recordings.get(visit.id) ?? [];
        const customer = customers.get(visit.customer_id) ?? null;
        return {
          id: visit.id,
          seatId: visit.seat_id,
          repHrId: visit.rep_hr_id,
          managerHrId: visit.manager_hr_id,
          productManagerHrId: visit.product_manager_hr_id,
          seniorHrId: visit.senior_hr_id,
          customerId: visit.customer_id,
          listType: visit.list_type,
          visitDate: String(visit.visit_date).slice(0, 10),
          capturedAt: visit.captured_at,
          createdAt: visit.created_at,
          isTest: visit.is_test === true,
          isUnplanned: visit.is_unplanned === true,
          unplannedKind: visit.unplanned_kind,
          unplannedStatus: approval?.status ?? null,
          recordingStatuses: claimed.map((recording) => String(recording.review_status ?? "")),
          // `coalesce(c.validated_at is not null or c.list_type = 'Pharmacy', false)` — a missing customer is false.
          customerValidated: customer ? customer.validated_at !== null || customer.list_type === "Pharmacy" : false,
          contactCrmId: customer ? (toNumber(customer.reference_contact_crm_id) ?? toNumber(customer.own_contact_crm_id)) : null,
          factsChangedAt:
            laterOf(
              visit.created_at,
              approval?.updated_at,
              ...claimed.flatMap((recording) => [recording.claimed_at, recording.reviewed_at, recording.deleted_at]),
              removed.get(visit.id),
              edits.get(visit.id),
            ) ?? visit.created_at,
          removed: removed.has(visit.id),
        };
      });
    },

    async readCountableIds(ids) {
      const out = new Set<string>();
      for (const chunk of chunks(unique(ids), ID_CHUNK)) {
        const { data, error } = await supabase.from("phoenix_crm_countable_visits").select("id").in("id", chunk);
        if (error) throw readError("phoenix_crm_countable_visits", error);
        for (const row of (data ?? []) as Array<{ id: string }>) out.add(String(row.id));
      }
      return out;
    },

    async readStartedTeamSeats() {
      const { rpcAll } = await import("@/lib/supabase/server");
      const rows = await rpcAll<{ seat_id: string; team_seat_id: string; starts_on: string; stops_on: string | null }>(
        supabase,
        "phoenix_crm_started_team_seats",
        {},
        ["seat_id", "starts_on"],
      );
      return rows.map((row) => ({
        seatId: row.seat_id,
        teamSeatId: row.team_seat_id,
        startsOn: String(row.starts_on).slice(0, 10),
        stopsOn: row.stops_on ? String(row.stops_on).slice(0, 10) : null,
      }));
    },

    async readUnifiedRows(input) {
      // Through the read door with the departed exclusion lifted: S2 asks whether the view HOLDS the
      // visit, and the exclusion is S3's question.
      const { queryVisits } = await import("@/lib/crm/reads");
      const rows = await queryVisits<DoorRow>({
        agentCrmOrHrIds: { crmIds: input.crmIds, hrIds: input.hrIds },
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
        visitDates: input.visitDates,
        columns: DOOR_COLUMNS,
        includeResignedAgents: true,
      });
      const wanted = new Set(input.ids);
      return rows.filter((row) => row.source === "phoenix" && wanted.has(String(row.id)));
    },

    async readDoorVisits(input) {
      const { queryVisits } = await import("@/lib/crm/reads");
      return queryVisits<DoorRow>({
        agentCrmOrHrIds: { crmIds: input.crmIds, hrIds: input.hrIds },
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
        visitDates: input.visitDates,
        columns: DOOR_COLUMNS,
      });
    },

    async readExcludedAgentCrmIds() {
      const { getEffectiveExcludedAgentCrmIds } = await import("@/lib/crm/reads");
      return getEffectiveExcludedAgentCrmIds();
    },

    async readPeople() {
      const { getEmployeeDirectoryRows } = await import("@/lib/employees/employee-directory");
      const rows = await getEmployeeDirectoryRows({ includeInactive: true });
      const people: PersonFacts[] = [];
      for (const row of rows) {
        const hrKey = canonicalHrIdKey(row.hrId);
        if (!hrKey) continue;
        people.push({
          hrKey,
          hrId: row.hrId,
          fullName: row.fullName ?? null,
          crmId: toNumber(row.crmId),
          employmentStatus: row.employmentStatus ?? null,
          lastWorkingDate: row.lastWorkingDate ?? null,
          hireDate: row.hireDate ?? null,
          jobTitle: row.jobTitle ?? null,
        });
      }
      return people;
    },

    async readCalendarDays(days) {
      const { getPrivateCalendarDayEvidence } = await import("@/lib/private-calendar/service");
      const out = new Map<string, CalendarDayReading>();
      const reps = unique(days.map((day) => day.hrId));
      for (const group of chunks(reps, CALENDAR_REPS_PER_CALL)) {
        const inGroup = new Set(group);
        const evidence = await getPrivateCalendarDayEvidence(
          days.filter((day) => inGroup.has(day.hrId)).map((day) => ({ date: day.date, employeeHrId: day.hrId })),
        );
        for (const day of evidence.values()) {
          const hrKey = canonicalHrIdKey(day.employeeHrId);
          if (!hrKey) continue;
          const key = `${hrKey}|${day.date}`;
          if (day.unreadableSources.includes("field_visit")) {
            out.set(key, { readable: false, sources: ["private calendar field visits"] });
            continue;
          }
          const phoenix = day.items
            .filter((item) => item.source === "field_visit")
            .reduce((sum, item) => sum + (item.visitCounts?.phoenix ?? 0), 0);
          out.set(key, { readable: true, phoenix });
        }
      }
      return out;
    },

    async readKpiTotal({ person, month, callRateTo, today }) {
      const { loadPhoenixRepKpis } = await import("@/lib/crm/phoenix-kpi-data");
      const load = await loadPhoenixRepKpis({
        scope: { kind: "agents", basis: "self", agentHrIds: [person.hrId], label: "System audit — visit lifecycle" },
        window: { dateFrom: month.start, dateTo: today < month.end ? today : month.end, windowEnd: month.end, callRateTo },
        month,
        today,
        employees: [{ hrId: person.hrId, hireDate: person.hireDate, lastWorkingDate: person.lastWorkingDate }],
        narrowToScope: true,
      });
      const kpis = load.kpisFor(person.hrKey);
      return {
        total: kpis.am.visits + kpis.pm.visits + kpis.pharmacy.visits + kpis.campaignVisits + kpis.regularNoCheckin,
        holidaysComplete: load.holidaysComplete,
      };
    },

    async readHolidays(month) {
      const { loadCallRateHolidays } = await import("@/lib/crm/call-rate-holidays");
      const lookup = await loadCallRateHolidays(month.start, month.end);
      return { complete: lookup.complete, dates: lookup.dates };
    },
  };
}

/**
 * The production detector. Built lazily so importing this module (the historical runner, the tests)
 * never reaches for the service-role client.
 */
export const visitLifecycleDetector: AuditDetector = {
  id: VISIT_LIFECYCLE_DETECTOR_ID,
  family: "visit_lifecycle",
  version: DETECTOR_VERSION,
  async run(ctx) {
    const { getSupabaseAdmin } = await import("@/lib/supabase/server");
    return createVisitLifecycleDetector({ ports: createDatabaseVisitLifecyclePorts(getSupabaseAdmin({ requestTimeoutMs: 20_000 })) }).run(ctx);
  },
};
