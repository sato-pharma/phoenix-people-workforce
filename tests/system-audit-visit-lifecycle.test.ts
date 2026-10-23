import assert from "node:assert/strict";

import { canonicalHrIdKey } from "../src/lib/hr-id.ts";
import {
  createDatabaseVisitLifecyclePorts,
  createVisitLifecycleDetector,
  VISIT_LIFECYCLE_DETECTOR_ID,
  type CalendarDayReading,
  type RepDayTouch,
  type VisitLifecyclePorts,
} from "../src/lib/system-audit/detectors/visit-lifecycle.ts";
import {
  lifecycleCorrelationId,
  predictDoorRow,
  uuidV5,
  type DoorRow,
  type PersonFacts,
  type SavedVisit,
  type StartedSeatWindow,
} from "../src/lib/system-audit/detectors/visit-lifecycle-expected.ts";
import type { AuditOccurrenceInput, DetectorContext, DetectorResult, FindingBatch, FindingSink } from "../src/lib/system-audit/types.ts";

/**
 * The visit_lifecycle detector end to end, against a world the test builds: every saved visit says
 * which doors hold it (countable set, unified view, read door, calendar chip, call rate), and the
 * detector must tell a visit a business rule left out — counted, never a finding — from a visit that
 * was lost, which writes ONE root row and links every consumer that missed it on one correlation id.
 *
 * Cron "now" is Wednesday 18 November 2026, 12:00 UTC (14:00 Cairo): the quiet line is 10:00 UTC and
 * the call rate runs 1–17 November (yesterday). 1 November is a Sunday, 12 November a Thursday.
 */

const NOW = Date.parse("2026-11-18T12:00:00.000Z");
const DAY = "2026-11-16";
const START_CURSOR = { touchedAfter: "2026-11-15T00:00:00.000Z", kpiQueue: [] as string[] };

type Flags = { inCountable: boolean; inUnified: boolean; inDoor: boolean; inCalendar: boolean; inKpi: boolean };
const ALL: Flags = { inCountable: true, inUnified: true, inDoor: true, inCalendar: true, inKpi: true };
const NONE: Flags = { inCountable: false, inUnified: false, inDoor: false, inCalendar: false, inKpi: false };
type Fixture = { visit: SavedVisit; flags: Flags };

type World = {
  people: PersonFacts[];
  windows: StartedSeatWindow[];
  excluded: number[];
  fixtures: Fixture[];
  vendorRows?: DoorRow[];
  /** Extra Phoenix visits the calendar chip counts, by `${hrKey}|${date}`. */
  calendarExtra?: Record<string, number>;
  /** Extra visits the KPIs board counts, by `${hrKey}|${YYYY-MM}`. */
  kpiExtra?: Record<string, number>;
  failCalendar?: boolean;
};

function person(hrId: string, crmId: number, overrides: Partial<PersonFacts> = {}): PersonFacts {
  return {
    hrKey: canonicalHrIdKey(hrId) as string,
    hrId,
    fullName: `Rep ${hrId}`,
    crmId,
    employmentStatus: "active",
    lastWorkingDate: null,
    hireDate: "2025-01-01",
    jobTitle: "Medical Representative",
    ...overrides,
  };
}

const REP = person("B-200", 5001);
const REP_TWO = person("B-201", 5002);
const SEAT_A: StartedSeatWindow = { seatId: "SEAT-A", teamSeatId: "TEAM-A", startsOn: "2026-10-01", stopsOn: null };

let sequence = 0;
function visit(overrides: Partial<SavedVisit> & { repHrId?: string | null } = {}): SavedVisit {
  sequence += 1;
  const visitDate = overrides.visitDate ?? DAY;
  const createdAt = overrides.createdAt ?? `${visitDate}T09:00:00.000Z`;
  return {
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    seatId: "SEAT-A",
    repHrId: REP.hrId,
    managerHrId: null,
    productManagerHrId: null,
    seniorHrId: null,
    customerId: `customer-${sequence}`,
    listType: "AM",
    visitDate,
    capturedAt: `${visitDate}T08:00:00.000Z`,
    createdAt,
    isTest: false,
    isUnplanned: false,
    unplannedKind: null,
    unplannedStatus: null,
    recordingStatuses: [],
    customerValidated: true,
    contactCrmId: 10_000 + sequence,
    factsChangedAt: overrides.factsChangedAt ?? createdAt,
    removed: false,
    ...overrides,
  };
}

function fixture(overrides: Partial<SavedVisit> & { repHrId?: string | null } = {}, flags: Partial<Flags> = {}): Fixture {
  return { visit: visit(overrides), flags: { ...ALL, ...flags } };
}

function groupTouches(fixtures: readonly Fixture[]): RepDayTouch[] {
  const byKey = new Map<string, RepDayTouch>();
  for (const { visit: saved } of fixtures) {
    const hrKey = canonicalHrIdKey(saved.repHrId);
    if (!hrKey || !saved.repHrId || saved.isTest) continue;
    const key = `${hrKey}|${saved.visitDate}`;
    const entry = byKey.get(key) ?? { hrKey, hrIds: [saved.repHrId], date: saved.visitDate, lastTouchAt: saved.createdAt };
    if (Date.parse(saved.createdAt) > Date.parse(entry.lastTouchAt)) entry.lastTouchAt = saved.createdAt;
    byKey.set(key, entry);
  }
  return [...byKey.values()];
}

function portsFor(world: World): VisitLifecyclePorts {
  const personOf = (hrId: string | null) => world.people.find((entry) => entry.hrKey === canonicalHrIdKey(hrId)) ?? null;
  const keyOf = (saved: SavedVisit) => `${canonicalHrIdKey(saved.repHrId)}|${saved.visitDate}`;
  const doorRow = (saved: SavedVisit) => predictDoorRow(saved, personOf(saved.repHrId));
  return {
    async readTouchedRepDays({ after, until }) {
      return groupTouches(
        world.fixtures.filter(({ visit: saved }) => Date.parse(saved.createdAt) > Date.parse(after) && Date.parse(saved.createdAt) <= Date.parse(until)),
      );
    },
    async listRepDays({ from, to }) {
      return groupTouches(world.fixtures.filter(({ visit: saved }) => saved.visitDate >= from && saved.visitDate <= to));
    },
    async readSavedVisits({ hrIds, dates }) {
      const keys = new Set(hrIds.map((hrId) => canonicalHrIdKey(hrId)));
      return world.fixtures.filter(({ visit: saved }) => keys.has(canonicalHrIdKey(saved.repHrId)) && dates.includes(saved.visitDate)).map(({ visit: saved }) => saved);
    },
    async readCountableIds(ids) {
      return new Set(world.fixtures.filter(({ visit: saved, flags }) => flags.inCountable && ids.includes(saved.id)).map(({ visit: saved }) => saved.id));
    },
    async readStartedTeamSeats() {
      return world.windows;
    },
    async readUnifiedRows(input) {
      return world.fixtures.filter(({ visit: saved, flags }) => flags.inUnified && input.ids.includes(saved.id)).map(({ visit: saved }) => doorRow(saved));
    },
    async readDoorVisits(input) {
      const keys = new Set(input.hrIds.map((hrId) => canonicalHrIdKey(hrId)));
      const crmIds = new Set(input.crmIds);
      const phoenix = world.fixtures
        .filter(({ visit: saved, flags }) => flags.inDoor && input.visitDates.includes(saved.visitDate) && keys.has(canonicalHrIdKey(saved.repHrId)))
        .map(({ visit: saved }) => doorRow(saved));
      const vendor = (world.vendorRows ?? []).filter(
        (row) =>
          input.visitDates.includes(String(row.visit_date)) && (keys.has(canonicalHrIdKey(row.agent_hr_id)) || (row.agent_crm_id != null && crmIds.has(row.agent_crm_id))),
      );
      return [...phoenix, ...vendor];
    },
    async readExcludedAgentCrmIds() {
      return world.excluded;
    },
    async readPeople() {
      return world.people;
    },
    async readCalendarDays(days) {
      if (world.failCalendar) throw new Error("the calendar could not be read");
      const out = new Map<string, CalendarDayReading>();
      for (const day of days) {
        const key = `${canonicalHrIdKey(day.hrId)}|${day.date}`;
        const shown = world.fixtures.filter(({ visit: saved, flags }) => flags.inCalendar && keyOf(saved) === key).length;
        out.set(key, { readable: true, phoenix: shown + (world.calendarExtra?.[key] ?? 0) });
      }
      return out;
    },
    async readKpiTotal({ person: rep, month, callRateTo }) {
      const counted = world.fixtures.filter(
        ({ visit: saved, flags }) =>
          flags.inKpi && canonicalHrIdKey(saved.repHrId) === rep.hrKey && saved.visitDate >= month.start && saved.visitDate <= callRateTo,
      ).length;
      return { total: counted + (world.kpiExtra?.[`${rep.hrKey}|${month.start.slice(0, 7)}`] ?? 0), holidaysComplete: true };
    },
    async readHolidays() {
      return { complete: true, dates: new Set<string>() };
    },
  };
}

type Run = { result: DetectorResult; writes: FindingBatch[]; occurrences: AuditOccurrenceInput[] };

async function run(
  world: World,
  options: {
    now?: number;
    cursor?: Record<string, unknown> | null;
    mode?: DetectorContext["mode"];
    window?: { from: string; to: string };
    batchSize?: number;
    deadline?: number;
    clock?: () => number;
    onWrite?: () => void;
  } = {},
): Promise<Run> {
  const writes: FindingBatch[] = [];
  const sink: FindingSink = {
    kind: "file",
    async write(detector, _runId, batch) {
      assert.equal(detector, VISIT_LIFECYCLE_DETECTOR_ID);
      writes.push(batch);
      options.onWrite?.();
      return { issues: batch.issues.length, inserted: batch.occurrences.length, updated: 0 };
    },
    async readCursor() {
      return options.cursor === undefined ? START_CURSOR : options.cursor;
    },
  };
  const now = options.now ?? NOW;
  const detector = createVisitLifecycleDetector({ ports: portsFor(world), batchSize: options.batchSize });
  const result = await detector.run({
    mode: options.mode ?? "cron",
    deadline: options.deadline ?? now + 60_000,
    sink,
    runId: null,
    now: options.clock ?? (() => now),
    window: options.window ?? null,
  });
  return { result, writes, occurrences: writes.flatMap((batch) => batch.occurrences) };
}

function roots(rows: readonly AuditOccurrenceInput[]) {
  return rows.filter((row) => row.isRootSymptom !== false);
}

export async function runSystemAuditVisitLifecycleTests() {
  // ── The correlation id is RFC 4122 version 5, so any night, any process, mints the same one ──
  assert.equal(
    uuidV5("www.example.com", "6ba7b810-9dad-11d1-80b4-00c04fd430c8"),
    "2ed6657d-e927-568b-95e1-2665a8aea6a2",
    "uuidV5 must reproduce the RFC 4122 DNS-namespace vector",
  );
  assert.equal(
    lifecycleCorrelationId("b-10", "2026-11-16", ["b", "a"]),
    "43106e3b-2262-5ec4-95cf-b5287f36b3a4",
    "the day correlation id is uuid5(namespace, day|hrKey|date|sorted ids) — ids in any order mint one id",
  );

  // ── A day where everything arrived writes nothing, and the call rate agrees ──
  {
    const world: World = { people: [REP], windows: [SEAT_A], excluded: [], fixtures: [fixture(), fixture(), fixture()] };
    const { result, occurrences, writes } = await run(world);
    assert.equal(result.status, "ok", `a clean run is ok (${result.error ?? ""})`);
    assert.deepEqual(occurrences, [], "three visits that reached every door write no finding");
    assert.equal(result.scanned, 1, "one rep-day judged");
    assert.equal((result.report as { kpiMonthsChecked: number }).kpiMonthsChecked, 1, "the rep's November call rate was checked");
    const last = writes[writes.length - 1].cursor as { touchedAfter: string; kpiQueue: string[] };
    assert.equal(last.touchedAfter, "2026-11-18T10:00:00.000Z", "a full pass leaves the cursor at the quiet line");
    assert.deepEqual(last.kpiQueue, [], "the checked rep-month leaves the queue in the same write as its rows");
  }

  // ── Every business rule that keeps a visit out is counted, and none is a finding ──
  {
    const departed = person("B-400", 6001, { employmentStatus: "resigned", lastWorkingDate: "2026-11-01" });
    const seatB: StartedSeatWindow = { seatId: "SEAT-B", teamSeatId: "TEAM-B", startsOn: "2026-11-17", stopsOn: null };
    const seatC: StartedSeatWindow = { seatId: "SEAT-C", teamSeatId: "TEAM-C", startsOn: "2026-10-01", stopsOn: "2026-11-10" };
    const seatE: StartedSeatWindow = { seatId: "SEAT-E", teamSeatId: "TEAM-E", startsOn: "2026-10-01", stopsOn: null };
    const first = fixture({ customerId: "customer-repeat", contactCrmId: 801 });
    const world: World = {
      people: [REP, departed],
      windows: [SEAT_A, seatB, seatC, seatE],
      excluded: [6001],
      fixtures: [
        fixture(),
        fixture(),
        fixture({ isTest: true }, NONE),
        fixture({ removed: true }, NONE),
        fixture({ factsChangedAt: "2026-11-18T11:00:00.000Z" }, NONE),
        fixture({ isUnplanned: true, unplannedKind: "out_of_plan", unplannedStatus: "admin_pending" }, NONE),
        fixture({ isUnplanned: true, unplannedKind: "out_of_plan", unplannedStatus: "manager_pending" }, NONE),
        fixture({ isUnplanned: true, unplannedKind: "out_of_plan", unplannedStatus: "sfe_pending" }, NONE),
        fixture({ isUnplanned: true, unplannedKind: "out_of_plan", unplannedStatus: "refused" }, NONE),
        // out_of_list always counts, approved or not.
        fixture({ isUnplanned: true, unplannedKind: "out_of_list", unplannedStatus: "manager_pending" }),
        fixture({ recordingStatuses: ["approved", "pending"] }, NONE),
        fixture({ seatId: "SEAT-X" }, { ...NONE, inCountable: true }),
        fixture({ seatId: "SEAT-B" }, { ...NONE, inCountable: true }),
        fixture({ seatId: "SEAT-C" }, { ...NONE, inCountable: true }),
        fixture({ repHrId: departed.hrId, seatId: "SEAT-E" }, { ...NONE, inCountable: true, inUnified: true }),
        first,
        fixture({ customerId: "customer-repeat", contactCrmId: 801 }, { ...NONE, inCountable: true, inUnified: true, inDoor: true }),
        fixture({ managerHrId: "B-900" }, { inCalendar: false }),
        // A rule-optional visit the call rate leaves out: no finding either way.
        fixture({ customerValidated: false }, { inKpi: false }),
        fixture({ contactCrmId: 100_000 }),
      ],
    };
    const { result, occurrences } = await run(world);
    assert.deepEqual(
      occurrences.map((row) => `${row.signatureKey} ${row.technicalMessage}`),
      [],
      "a visit a business rule leaves out is never a finding",
    );
    const counts = result.excludedCounts;
    const expected: Record<string, number> = {
      test_row: 1,
      removed_by_admin: 1,
      not_quiet: 1,
      offplan_pending_admin: 1,
      offplan_pending_manager: 1,
      offplan_pending_sfe: 1,
      offplan_refused: 1,
      recording_not_approved: 1,
      seat_not_in_started_team: 1,
      team_not_started: 1,
      team_stopped: 1,
      departed_agent: 1,
      repeat_save_collapsed: 1,
      partnered_double_feed: 1,
    };
    for (const [reason, count] of Object.entries(expected)) {
      // The KPI month re-judges the days but reports only its own call-rate exclusions, so a visit a
      // business rule left out is counted once on the run, never once per pass.
      assert.equal(counts[reason] ?? 0, count, `the ${reason} exclusion is counted once on the run`);
    }
    assert.equal(counts.kpi_unvalidated_customer, 1, "the unvalidated customer is counted as optional on the call rate");
    assert.equal(counts.kpi_catch_all_contact, 1, "the catch-all contact is counted as optional on the call rate");
  }

  // ── The two measured groups: 19 off-plan visits waiting for a manager, 18 saved before the team started ──
  {
    const late = person("B-300", 5003);
    const seatA: StartedSeatWindow = { seatId: "SEAT-A", teamSeatId: "TEAM-A", startsOn: "2026-10-10", stopsOn: null };
    const seatD: StartedSeatWindow = { seatId: "SEAT-D", teamSeatId: "TEAM-D", startsOn: "2026-10-10", stopsOn: null };
    const fixtures: Fixture[] = [];
    for (let index = 0; index < 19; index += 1) {
      fixtures.push(fixture({ visitDate: "2026-10-14", isUnplanned: true, unplannedKind: "out_of_plan", unplannedStatus: "manager_pending" }, NONE));
    }
    for (let index = 0; index < 18; index += 1) {
      fixtures.push(fixture({ repHrId: late.hrId, seatId: "SEAT-D", visitDate: "2026-10-07" }, { ...NONE, inCountable: true }));
    }
    const world: World = { people: [REP, late], windows: [seatA, seatD], excluded: [], fixtures };
    const { result, occurrences, writes } = await run(world, {
      mode: "historical",
      window: { from: "2026-10-03", to: "2026-10-22" },
      now: Date.parse("2026-10-23T12:00:00.000Z"),
      cursor: null,
    });
    assert.equal(result.status, "ok", `the historical run is ok (${result.error ?? ""})`);
    assert.deepEqual(occurrences, [], "neither measured group is a finding");
    assert.equal(result.excludedCounts.offplan_pending_manager, 19, "19 off-plan visits waiting for the manager, each counted once (the month pass never re-counts a day's exclusion)");
    assert.equal(result.excludedCounts.team_not_started, 18, "18 visits saved before the team started, each counted once (the month pass never re-counts a day's exclusion)");
    assert.equal(result.excludedCounts.kpi_old_rules_mid_period, 2, "both teams went live inside October, so its call rate keeps the old rules");
    assert.ok(writes.every((batch) => batch.cursor === null), "a historical run never moves the cron watermark");
  }

  // ── A visit lost at the unified view writes exactly one root row, and every consumer links to it ──
  {
    const lost = fixture({}, { inUnified: false, inDoor: false, inCalendar: false, inKpi: false });
    const world: World = { people: [REP], windows: [SEAT_A], excluded: [], fixtures: [fixture(), lost, fixture()] };
    const { occurrences, writes } = await run(world);
    const root = roots(occurrences);
    assert.equal(root.length, 1, `one lost visit is ONE root row (got ${root.map((row) => row.signatureKey).join(", ")})`);
    assert.equal(root[0].signatureKey, "visit:s2:unified", "the root is the first stage that lost it");
    assert.equal(root[0].errorCode, "VISIT-S2-MISSING");
    assert.equal(root[0].dedupeKey, `visit:s2:phoenix_crm:b-200:${DAY}`);
    assert.equal(root[0].affectedDate, DAY);
    assert.equal(root[0].moduleLabel, "Phoenix CRM", "named by the rep's own sidebar");
    assert.deepEqual((root[0].evidence as { visitIds: string[] }).visitIds, [lost.visit.id]);
    const correlation = lifecycleCorrelationId("b-200", DAY, [lost.visit.id]);
    assert.equal(root[0].correlationId, correlation);
    const linked = occurrences.filter((row) => row.isRootSymptom === false);
    assert.deepEqual(
      linked.map((row) => row.signatureKey).sort(),
      ["visit:s4:private_calendar", "visit:s5:kpis"],
      "the calendar and the call rate each write a linked row, not a root",
    );
    assert.ok(linked.every((row) => row.correlationId === correlation), "every consumer's row carries the root's correlation id");
    const issues = writes.flatMap((batch) => batch.issues);
    assert.ok(issues.every((issue) => issue.family === "visit_lifecycle"), "every issue is in the visit_lifecycle family");
  }

  // ── R2: an employed rep hidden as departed — an S3 root, the calendar and the call rate linked ──
  {
    const hidden = [fixture({}, { inDoor: false, inCalendar: false, inKpi: false }), fixture({}, { inDoor: false, inCalendar: false, inKpi: false })];
    const world: World = { people: [REP], windows: [SEAT_A], excluded: [REP.crmId as number], fixtures: hidden };
    const { occurrences } = await run(world);
    const root = roots(occurrences);
    assert.deepEqual(root.map((row) => row.signatureKey), ["visit:s3:reader:departed"], "the rep's own CRM id on the departed list is an S3 root");
    const correlation = lifecycleCorrelationId("b-200", DAY, hidden.map((entry) => entry.visit.id));
    const linked = occurrences.filter((row) => row.isRootSymptom === false);
    assert.deepEqual(linked.map((row) => row.signatureKey).sort(), ["visit:s4:private_calendar", "visit:s5:kpis"]);
    assert.ok(
      [...root, ...linked].every((row) => row.correlationId === correlation),
      "the S3 root, the calendar row and the call-rate row share ONE correlation id",
    );
    assert.equal((linked.find((row) => row.signatureKey === "visit:s5:kpis")?.evidence as { missing: number }).missing, 2);
  }

  // ── R3: two different customers folded into one stop by a shared contact id ──
  {
    const kept = fixture({ contactCrmId: 777 });
    const folded = fixture({ contactCrmId: 777 }, { inCalendar: false, inKpi: false });
    const world: World = { people: [REP], windows: [SEAT_A], excluded: [], fixtures: [kept, folded] };
    const { occurrences } = await run(world);
    const root = roots(occurrences);
    assert.deepEqual(root.map((row) => row.signatureKey), ["visit:s3:reader:merged"], "a different customer folded away is a loss, not a re-save");
    assert.deepEqual((root[0].evidence as { visitIds: string[] }).visitIds, [folded.visit.id]);
  }

  // ── S1: an off-plan visit saved with no approval row, and one counted before it was approved ──
  {
    const stuck = fixture({ isUnplanned: true, unplannedKind: "out_of_plan", unplannedStatus: null }, NONE);
    const early = fixture({ repHrId: REP_TWO.hrId, isUnplanned: true, unplannedKind: "out_of_plan", unplannedStatus: "manager_pending" }, { ...NONE, inCountable: true });
    const world: World = { people: [REP, REP_TWO], windows: [SEAT_A], excluded: [], fixtures: [stuck, early] };
    const { occurrences, writes } = await run(world);
    const root = roots(occurrences).map((row) => row.signatureKey).sort();
    assert.deepEqual(root, ["visit:s1:countable:extra", "visit:s1:countable:no_approval"]);
    const issue = writes.flatMap((batch) => batch.issues).find((entry) => entry.signatureKey === "visit:s1:countable:no_approval");
    assert.equal(issue?.rootCauseLevel, "confirmed", "a missing approval row is a confirmed cause");
  }

  // ── R8: the calendar counts a visit twice ──
  {
    const world: World = { people: [REP], windows: [SEAT_A], excluded: [], fixtures: [fixture(), fixture()], calendarExtra: { [`b-200|${DAY}`]: 1 } };
    const { occurrences } = await run(world);
    assert.deepEqual(roots(occurrences).map((row) => row.signatureKey), ["visit:s4:private_calendar:extra"], "a calendar count above what the door serves is its own root");
  }

  // ── R12: an iReports360 row served on the rep's Phoenix CRM day ──
  {
    const vendor: DoorRow = {
      id: "ireports360-1",
      source: "ireports360",
      agent_hr_id: REP.hrId,
      agent_crm_id: REP.crmId,
      exclusion_crm_id: REP.crmId,
      contact_crm_id: 555,
      visit_date: DAY,
      visit_type: 0,
      visit_type_description: "Regular Visit",
      comment: null,
      double_hr_id: null,
      double_crm_id: null,
      crm_save_date: null,
      crm_visit_id: 1,
      ampm: "AM",
      speciality: null,
      phoenix_customer_validated: null,
    };
    const world: World = { people: [REP], windows: [SEAT_A], excluded: [], fixtures: [fixture()], vendorRows: [vendor], kpiExtra: { "b-200|2026-11": 1 } };
    const { occurrences } = await run(world);
    assert.deepEqual(roots(occurrences).map((row) => row.signatureKey), ["visit:s3:reader:vendor"], "the vendor row beside a Phoenix CRM day is its own root");
  }

  // ── A calendar that cannot be read is UNKNOWN, never a pass and never a loss ──
  {
    const world: World = { people: [REP], windows: [SEAT_A], excluded: [], fixtures: [fixture(), fixture()], failCalendar: true };
    const { result, occurrences, writes } = await run(world);
    assert.deepEqual(occurrences.map((row) => row.signatureKey), ["visit:s4:private_calendar:unreadable"], "an unread calendar writes one UNKNOWN row");
    const issue = writes.flatMap((batch) => batch.issues).find((entry) => entry.signatureKey === "visit:s4:private_calendar:unreadable");
    assert.equal(issue?.status, "unknown", "its issue opens as UNKNOWN — INSUFFICIENT EVIDENCE");
    assert.equal((occurrences[0].evidence as { unreadable: boolean }).unreadable, true);
    assert.equal(result.status, "partial", "a run with an unread source is partial");
    assert.ok(result.unreadableSources.includes("private calendar"), "and names the source");
  }

  // ── A rep-day still in motion waits for the next run ──
  {
    const world: World = { people: [REP], windows: [SEAT_A], excluded: [], fixtures: [fixture({ visitDate: "2026-11-18", createdAt: "2026-11-18T11:00:00.000Z" }, NONE)] };
    const { result, occurrences, writes } = await run(world);
    assert.deepEqual(occurrences, []);
    assert.equal(result.excludedCounts.rep_day_not_quiet, 1, "a rep-day touched inside the quiet window is deferred and counted");
    assert.equal((writes[writes.length - 1].cursor as { touchedAfter: string }).touchedAfter, "2026-11-18T10:00:00.000Z", "the cursor stops at the quiet line, before the deferred day");
  }

  // ── A spent budget returns the cursor at the last rep-day written, one millisecond short of a tie ──
  for (const tie of [true, false]) {
    let clock = NOW;
    const world: World = {
      people: [REP, REP_TWO],
      windows: [SEAT_A],
      excluded: [],
      fixtures: [
        fixture({ createdAt: "2026-11-17T09:00:00.000Z" }),
        fixture({ repHrId: REP_TWO.hrId, createdAt: tie ? "2026-11-17T09:00:00.000Z" : "2026-11-17T09:30:00.000Z" }),
      ],
    };
    const { result, writes } = await run(world, {
      batchSize: 1,
      deadline: NOW + 1,
      clock: () => clock,
      onWrite: () => {
        clock = NOW + 10;
      },
    });
    assert.equal(result.status, "budget_exhausted", "the run stops when the deadline passes");
    assert.equal(writes.length, 1, "exactly the one batch it finished is written");
    const cursor = writes[0].cursor as { touchedAfter: string; kpiQueue: string[] };
    assert.equal(
      cursor.touchedAfter,
      tie ? "2026-11-17T08:59:59.999Z" : "2026-11-17T09:00:00.000Z",
      tie ? "a tied rep-day not yet judged keeps the cursor one millisecond short of it" : "the cursor sits on the last rep-day written",
    );
    assert.deepEqual(cursor.kpiQueue, ["b-200|2026-11"], "the judged rep-day's month waits in the queue for the next run");
    assert.deepEqual(result.watermarkTo, { touchedAfter: cursor.touchedAfter, kpiQueued: 1 }, "the run reports the watermark it wrote");
  }

  // ── The database ports name each table's REAL key, never an `id` the table does not have ──
  //
  // 🔴 WHY THIS EXISTS. Every case above runs the detector against ports the test builds, so none of
  // them ever touched `createDatabaseVisitLifecyclePorts` — and that is where the detector actually
  // broke. It paged `phoenix_crm_visit_recordings` with `tiebreak: "id"` and selected `id`, on a
  // table keyed on `path` with no `id` column at all. PostgREST answers a missing column with 42703
  // and fails the WHOLE read, so the entire detector died: `System audit detector failed:
  // visit_lifecycle` on production from 23 Oct 2026 10:56 Cairo, every sweep, with four green
  // required checks on the PR that introduced it. A select is a string the compiler never reads.
  {
    // Every table these ports page, read from `pg_index` and `information_schema.columns` on
    // production (ozucdzovmcqvepbozvqf) on 23 Oct 2026: whether it has an `id` column at all, and
    // which of its columns carry a UNIQUE index — the only ones that make a page order total.
    // `phoenix_crm_removed_visits` is keyed on `id` and ALSO unique on `visit_id`
    // (phoenix_crm_removed_visits_one), so ordering it by `visit_id` is correct, not a near miss.
    const TABLES: Record<string, { hasId: boolean; totalOrder: string[] }> = {
      phoenix_crm_visits: { hasId: true, totalOrder: ["id"] },
      phoenix_crm_unplanned_visits: { hasId: false, totalOrder: ["visit_id"] },
      phoenix_crm_visit_recordings: { hasId: false, totalOrder: ["path", "visit_id"] },
      phoenix_crm_visit_edits: { hasId: true, totalOrder: ["id"] },
      phoenix_crm_removed_visits: { hasId: true, totalOrder: ["id", "visit_id"] },
      phoenix_crm_customers: { hasId: true, totalOrder: ["id"] },
    };
    type Read = { table: string; columns: string[]; orders: string[] };
    const reads: Read[] = [];
    // One visit row, so the per-chunk reads that depend on having ids actually run.
    const VISIT = { id: "11111111-1111-4111-8111-111111111111", rep_hr_id: REP.hrId, visit_date: DAY, created_at: "2026-11-16T09:00:00.000Z", customer_id: null, is_test: false };
    const client = {
      from(table: string) {
        const read: Read = { table, columns: [], orders: [] };
        reads.push(read);
        const answer = () => Promise.resolve({ data: table === "phoenix_crm_visits" ? [VISIT] : [], error: null });
        const chain: Record<string, unknown> = {
          select(columns: string) {
            read.columns = columns.split(",").map((column) => column.trim());
            return chain;
          },
          order(column: string) {
            read.orders.push(column);
            return chain;
          },
          then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
            return answer().then(resolve, reject);
          },
        };
        for (const method of ["in", "not", "eq", "gt", "gte", "lte", "range", "limit"]) chain[method] = () => chain;
        return chain;
      },
    };

    const ports = createDatabaseVisitLifecyclePorts(client as never);
    await ports.readTouchedRepDays({ after: "2026-11-15T00:00:00.000Z", until: "2026-11-18T10:00:00.000Z" });
    await ports.readSavedVisits({ hrIds: [REP.hrId], dates: [DAY] });

    const known = reads.filter((read) => TABLES[read.table]);
    assert.ok(known.length >= 8, `the stub client must observe the ports' reads, saw ${known.length}`);
    const recordings = known.filter((read) => read.table === "phoenix_crm_visit_recordings");
    assert.ok(recordings.length >= 4, `the recordings table is read in both ports, saw ${recordings.length} read(s)`);

    for (const read of known) {
      const { hasId, totalOrder } = TABLES[read.table];
      for (const column of read.columns) {
        assert.ok(column !== "id" || hasId, `${read.table} has no id column, but a select names id — PostgREST fails the whole read with 42703`);
      }
      for (const column of read.orders) {
        assert.ok(column !== "id" || hasId, `${read.table} has no id column, but a read orders by id — PostgREST fails the whole read with 42703`);
      }
      if (read.orders.length === 0) continue;
      const tiebreak = read.orders[read.orders.length - 1];
      assert.ok(
        totalOrder.includes(tiebreak),
        `${read.table} must break its page order on a column that is unique on it (${totalOrder.join(" or ")}), not ${tiebreak} — otherwise paging can repeat or skip rows`,
      );
    }
  }

  console.log("system-audit-visit-lifecycle: PASS");
}
