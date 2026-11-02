import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { fakeSupabaseClient } from "./fixtures/fake-supabase-table.ts";
import { stripComments } from "./support/comment-strip.ts";

import { withdrawInAppNotificationsByEventKeyPrefix } from "../src/lib/notifications/in-app.ts";
import { phoenixCrmVisitNoticeKeyPrefix, withdrawPhoenixCrmVisitNotices } from "../src/lib/phoenix-crm/server/notifications.ts";

import {
  isActivityEnteredForRep,
  isEnteredForRep,
  isMissedRecordDay,
  MISSED_RECORD_MARK,
  opensForMissedRecords,
  parseMissedActivity,
  parseMissedVisit,
  parseRemoveMissedVisit,
  parseVisitTime,
} from "../src/lib/phoenix-crm/missed-records.ts";
import {
  canEnterMissedRecordOn,
  canEnterMissedRecords,
  territoryForMissedRecord,
  territoryForMissedRecordRemoval,
  type PhoenixCrmViewer,
} from "../src/lib/phoenix-crm/server/access.ts";
import { buildOrgIndex, type OrgSeat } from "../src/lib/phoenix-crm/scope.ts";

/**
 * Phoenix CRM — a record a rep MISSED, entered for him by the Super Admin (owner, 2026-10-01).
 *
 * His four answers, each pinned here:
 *   1. "the rep is responsible for all his records, but if he missed a visit or a record, admin can
 *      enter it for him" — the Super Admin ALONE, and it adds what is missing, never rewriting what
 *      the rep recorded;
 *   2. "for anyone, anytime, anywhere" — any rep, any day that has begun, and with NO location;
 *   3. "I choose planned or unplanned" — his choice, required, never inferred;
 *   4. "marked as entered by admin" — read from who entered the visit, because `capture_source` is a
 *      rep-blind column (tests/phoenix-crm-blind-half).
 *
 * And the one thing the owner never had to say, because it is Golden rule #1: a visit with no
 * location can never accuse a rep. Every reader that measures a location leaves it out, and the
 * location checks' coordinate read no longer turns a missing reading into 0°N 0°E.
 */

function source(path: string): string {
  return stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
}

const VISIT_DAY = "2026-10-01";
const VISIT_ID = "6f1c9a7e-3b2d-4c1e-9a8f-0b1c2d3e4f50";
const CUSTOMER_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

function visit(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: VISIT_ID,
    customerId: CUSTOMER_ID,
    visitDate: "2026-09-30",
    visitTime: "",
    planned: true,
    products: ["Saginko"],
    comment: "Discussed the new pack",
    ...patch,
  };
}

// ── The organogram the gate is tried against ────────────────────────────────────────────────────

const CEO: OrgSeat = {
  seatId: "SEAT-ROOT-CEO",
  parentSeatId: null,
  tier: "CEO",
  path: ["SEAT-ROOT-CEO"],
  occupantHrId: "C-1",
  lineCode: null,
  lineName: null,
  areaName: null,
  regionName: null,
  seatLabel: "CEO",
};
const DM: OrgSeat = {
  ...CEO,
  seatId: "SEAT-AIF-DM-D1",
  parentSeatId: "SEAT-ROOT-CEO",
  tier: "DM",
  path: ["SEAT-ROOT-CEO", "SEAT-AIF-DM-D1"],
  occupantHrId: "B-12",
  lineCode: "anti_infective",
  lineName: "Anti Infective",
  seatLabel: "AIF Delta (1) DM",
};
const REP: OrgSeat = {
  ...DM,
  seatId: "SEAT-AIF-REP-D13",
  parentSeatId: "SEAT-AIF-DM-D1",
  tier: "REP",
  path: ["SEAT-ROOT-CEO", "SEAT-AIF-DM-D1", "SEAT-AIF-REP-D13"],
  occupantHrId: "B-7",
  areaName: "Menoufia 2",
  seatLabel: "AIF D13 rep",
};
const VACANT: OrgSeat = { ...REP, seatId: "SEAT-AIF-REP-D14", path: ["SEAT-ROOT-CEO", "SEAT-AIF-DM-D1", "SEAT-AIF-REP-D14"], occupantHrId: null };
const CLOSED_LINE: OrgSeat = {
  ...REP,
  seatId: "SEAT-CNS-REP-C1",
  path: ["SEAT-ROOT-CEO", "SEAT-CNS-REP-C1"],
  parentSeatId: "SEAT-ROOT-CEO",
  lineCode: "cns",
  lineName: "CNS",
  occupantHrId: "B-55",
};

const org = buildOrgIndex([CEO, DM, REP, VACANT, CLOSED_LINE]);

function viewer(patch: Partial<PhoenixCrmViewer> = {}): PhoenixCrmViewer {
  return {
    hrId: "B-10",
    role: "Super Admin",
    isSuperAdmin: true,
    isSfeManager: false,
    isTestPersona: false,
    basis: "all",
    canCreate: true,
    canApprove: true,
    canUpdate: true,
    org,
    config: { lineRollout: [] },
    cairoToday: VISIT_DAY,
    visitDay: VISIT_DAY,
    openLines: new Set(["anti_infective"]),
    ownTerritories: [],
    waitingTerritories: [],
    scopeTerritories: [REP, VACANT, CLOSED_LINE],
    waitingScopeTerritories: [],
    managerSeats: [],
    ...patch,
  } as unknown as PhoenixCrmViewer;
}

function refused(run: () => unknown, pattern: RegExp, message: string): void {
  assert.throws(run, (error: unknown) => error instanceof Error && pattern.test(error.message), message);
}

export async function runPhoenixCrmMissedRecordsTests(): Promise<void> {
  // ── 1 · The day: any day that has begun, never one still to come ───────────────────────────────
  {
    assert.equal(isMissedRecordDay("2026-10-01", VISIT_DAY), true, "the visit day running now");
    assert.equal(isMissedRecordDay("2025-01-15", VISIT_DAY), true, "anytime: a day long past");
    assert.equal(isMissedRecordDay("2026-10-02", VISIT_DAY), false, "a day that has not begun holds no visit to have missed");
    assert.equal(isMissedRecordDay("2026-02-30", VISIT_DAY), false, "not a day at all");
    assert.equal(isMissedRecordDay(null, VISIT_DAY), false);

    assert.equal(opensForMissedRecords("2026-09-14", VISIT_DAY), true, "the Super Admin's calendar cell opens on a past day");
    assert.equal(opensForMissedRecords("2026-10-02", VISIT_DAY), false, "and not on tomorrow");
    assert.equal(opensForMissedRecords("2026-09-14", null), false, "everybody else's cells open on work only, as before");
  }

  // ── 2 · The time: his, or noon; refused rather than guessed ─────────────────────────────────────
  {
    assert.deepEqual(parseVisitTime(""), { ok: true, value: null }, "no time: noon stands in, server-side");
    assert.deepEqual(parseVisitTime("14:30"), { ok: true, value: 870 });
    assert.deepEqual(parseVisitTime("9:05"), { ok: true, value: 545 });
    assert.deepEqual(parseVisitTime("00:00"), { ok: true, value: 0 });
    for (const bad of ["24:00", "12:60", "noon", "1430", "-1:00"]) {
      assert.equal(parseVisitTime(bad).ok, false, `"${bad}" is refused, not guessed`);
    }
  }

  // ── 3 · A visit: planned or unplanned is HIS choice, and the comment is required ────────────────
  {
    const planned = parseMissedVisit(visit(), VISIT_DAY);
    assert.equal(planned.ok, true);
    if (planned.ok) {
      assert.equal(planned.value.planned, true);
      assert.equal(planned.value.reason, null, "a planned visit carries no reason");
      assert.equal(planned.value.visitMinute, null);
      assert.equal(planned.value.visitId, VISIT_ID);
    }

    // 🔴 The choice is REQUIRED. Inferring it — from the plan, or from a missing value — is exactly
    // what "I choose planned or unplanned" rules out.
    for (const choice of [undefined, null, "true", "planned", 1]) {
      const parsed = parseMissedVisit(visit({ planned: choice }), VISIT_DAY);
      assert.equal(parsed.ok, false, `planned=${String(choice)} is not a choice`);
      if (!parsed.ok) assert.match(parsed.error, /planned or unplanned/);
    }

    const noReason = parseMissedVisit(visit({ planned: false }), VISIT_DAY);
    assert.equal(noReason.ok, false, "an unplanned visit needs a reason — the manager decides it");
    assert.equal(parseMissedVisit(visit({ planned: false, reason: "too short" }), VISIT_DAY).ok, false, "nine characters is not a reason");
    const unplanned = parseMissedVisit(visit({ planned: false, reason: "  Met him   at the hospital  " }), VISIT_DAY);
    assert.equal(unplanned.ok, true);
    if (unplanned.ok) assert.equal(unplanned.value.reason, "Met him at the hospital", "cleaned exactly as the database cleans it");

    // 🔴 Optional on HIS entry and only on his (owner, 2026-10-24) — a rep's own visit still needs both.
    const bare = parseMissedVisit(visit({ comment: "   ", products: [] }), VISIT_DAY);
    assert.ok(bare.ok && bare.value.comment === null && bare.value.products.length === 0, "the Super Admin may enter a visit with no comment and no products");
    // Single, double or chain is HIS choice: an older screen sends none and gets a single visit.
    assert.ok(planned.ok && planned.value.kind === "single" && planned.value.picked.length === 0);
    // A screen opened before 2026-10-27 still sends the manager and the one above him by name.
    const double = parseMissedVisit(visit({ kind: "double", managerHrId: " b-12 " }), VISIT_DAY);
    assert.ok(double.ok && double.value.kind === "double", "a double names one person");
    if (double.ok) assert.deepEqual(double.value.picked, ["B-12"]);
    assert.equal(parseMissedVisit(visit({ kind: "double" }), VISIT_DAY).ok, false, "a double needs its one person");
    assert.equal(parseMissedVisit(visit({ kind: "chain", managerHrId: "B-12" }), VISIT_DAY).ok, false, "a chain needs two or more");
    const chain = parseMissedVisit(visit({ kind: "chain", managerHrId: "B-12", seniorHrId: "B-3" }), VISIT_DAY);
    assert.ok(chain.ok);
    if (chain.ok) assert.deepEqual(chain.value.picked, ["B-12", "B-3"]);
    // 🔴 Any mix (owner, 2026-10-27: "Everything is applicable") — the product side too, on his entry.
    const wide = parseMissedVisit(visit({ kind: "chain", picked: ["B-12", "B-3", "pm-1", "B-12"] }), VISIT_DAY);
    assert.ok(wide.ok);
    if (wide.ok) assert.deepEqual(wide.value.picked, ["B-12", "B-3", "PM-1"], "each person once, in the order ticked");
    const strayPeople = parseMissedVisit(visit({ kind: "single", managerHrId: "B-12", seniorHrId: "B-3" }), VISIT_DAY);
    assert.ok(strayPeople.ok && strayPeople.value.picked.length === 0, "a single visit carries nobody else");
    assert.equal(parseMissedVisit(visit({ kind: "product_manager" }), VISIT_DAY).ok, false, "a visit with a product manager stays the rep's own");
    assert.equal(
      parseMissedVisit(visit({ products: Array.from({ length: 13 }, (_, index) => `Product ${index}`) }), VISIT_DAY).ok,
      false,
      "at most twelve, as on a rep's visit",
    );
    const repeated = parseMissedVisit(visit({ products: ["Saginko", " Saginko ", "Lacto Advanced"] }), VISIT_DAY);
    assert.ok(repeated.ok && repeated.value.products.length === 2, "a product chosen twice is one product");
    assert.equal(parseMissedVisit(visit({ visitDate: "2026-10-02" }), VISIT_DAY).ok, false, "tomorrow is refused");
    assert.equal(parseMissedVisit(visit({ id: "not-a-uuid" }), VISIT_DAY).ok, false);
    assert.equal(parseMissedVisit(visit({ customerId: "" }), VISIT_DAY).ok, false);
    assert.equal(parseMissedVisit(visit({ visitTime: "25:00" }), VISIT_DAY).ok, false);
  }

  // ── 4 · A day activity: entered, or cleared; never on a day still to come ──────────────────────
  {
    const entered = parseMissedActivity({ activityDate: "2026-09-29", activityType: "training", halfDay: true, note: " Regional day " }, VISIT_DAY);
    assert.ok(entered.ok && !entered.value.clear && entered.value.draft.activityType === "training" && entered.value.draft.note === "Regional day");
    const cleared = parseMissedActivity({ activityDate: "2026-09-29", clear: true }, VISIT_DAY);
    assert.ok(cleared.ok && cleared.value.clear);
    assert.equal(parseMissedActivity({ activityDate: "2026-09-29", activityType: "leave" }, VISIT_DAY).ok, false, "leave is HR's, never a day activity");
    assert.equal(parseMissedActivity({ activityDate: "2026-10-02", activityType: "meeting" }, VISIT_DAY).ok, false);
  }

  // ── 5 · The mark: read from WHO entered it ──────────────────────────────────────────────────────
  {
    assert.equal(isEnteredForRep({ enteredBy: "B-7", rep: "B-7", manager: null, senior: null }), false, "the rep's own visit");
    assert.equal(isEnteredForRep({ enteredBy: "B-12", rep: null, manager: "B-12", senior: null }), false, "a manager's own single visit");
    assert.equal(isEnteredForRep({ enteredBy: "B-12", rep: "B-7", manager: "B-12", senior: null }), false, "a double visit the manager entered");
    assert.equal(isEnteredForRep({ enteredBy: "B-10", rep: "B-7", manager: null, senior: null }), true, "entered for the rep by somebody not on it");
    assert.equal(isEnteredForRep({ enteredBy: "b-7 ", rep: "B-7", manager: null, senior: null }), false, "keys compared as stored, upper case");
    assert.equal(isEnteredForRep({ enteredBy: null, rep: "B-7", manager: null, senior: null }), false);

    assert.equal(isActivityEnteredForRep({ enteredBy: "B-7", rep: "B-7" }), false, "the rep's own day");
    assert.equal(isActivityEnteredForRep({ enteredBy: "B-10", rep: "B-7" }), true, "a day entered for him");
    assert.equal(MISSED_RECORD_MARK, "Entered by the Super Admin");

    // 🔴 Never from capture_source — that column is rep-blind (tests/phoenix-crm-blind-half). The row
    // the rep reads carries the boolean, and mapVisitRow derives it from the people on the visit.
    const visits = source("src/lib/phoenix-crm/server/visits.ts");
    assert.match(
      visits,
      /const enteredByAdmin = isEnteredForRep\(\{ enteredBy: row\.entered_by_hr_id, rep: row\.rep_hr_id, manager: row\.manager_hr_id, senior: row\.senior_hr_id \}\);/,
      "mapVisitRow reads the mark from who entered the visit",
    );
    // The WORDING moved to `visit-location-words.ts` on 2026-10-07, unchanged, so the old CRM's admin
    // reports could print the same sentences without dragging `server/visits.ts` — and with it
    // `getSupabaseAdmin` — into a client bundle. The pin follows the code: `server/visits.ts` still owns
    // WHO entered the visit (asserted above), and the sentence a manager then reads is asserted here.
    const words = source("src/lib/phoenix-crm/visit-location-words.ts");
    assert.match(words, /locationLabel: enteredByAdmin\s*\?\s*MISSED_VISIT_LOCATION_LABEL/, "a manager reads 'no location', never 'no place saved', on an entered visit");
    assert.match(
      visits,
      /visitLocationFor\(options\.sight, flag, numberOrNull\(row\.distance_meters\), numberOrNull\(row\.accuracy_meters\), enteredByAdmin, /,
      "and mapVisitRow still hands that boolean to the one shaper, so the move cannot have dropped it",
    );
    const activities = source("src/lib/phoenix-crm/server/day-activities.ts");
    assert.match(activities, /const DAY_ACTIVITY_COLUMNS = "id, activity_date, activity_type, half_day, note, entered_by_hr_id, rep_hr_id";/);
    assert.match(activities, /enteredByAdmin: isActivityEnteredForRep\(\{ enteredBy: row\.entered_by_hr_id, rep: row\.rep_hr_id \}\),/);

    // Every screen that shows the visit or the day says so in words.
    const tab = source("src/components/phoenix-crm/visits-tab.tsx");
    assert.match(tab, /if \(visit\.enteredByAdmin\) return MISSED_RECORD_MARK;/, "the rep's own Visits tab marks it");
    assert.equal((tab.match(/enteredByLine\(visit\)/g) ?? []).length >= 4, true, "on its card and in its table");
    assert.match(tab, /current\.enteredByAdmin \? <p[^>]*>\{MISSED_RECORD_MARK\}<\/p> : null/, "and on the day's activity");
    const day = source("src/components/phoenix-crm/day-detail-view.tsx");
    assert.match(day, /\{visit\.enteredByAdmin \? \(\s*<p className="break-words">\{MISSED_RECORD_MARK\}<\/p>/, "the day page marks the visit");
    assert.match(day, /dayActivity\.enteredByAdmin \? ` · \$\{MISSED_RECORD_MARK\}` : ""/, "and the day's activity");
    // Plan against actual prints the day's activity beside its misses — marked there too, and its read
    // carries who entered the day, or the mark could never be set on it.
    assert.match(activities, /\.select\(`id, seat_id, \$\{DAY_ACTIVITY_COLUMNS\}`\)/, "plan against actual reads who entered the day");
    const reportsService = source("src/lib/phoenix-crm/server/reports.ts");
    assert.match(reportsService, /\}\)\}\$\{activity\.enteredByAdmin \? ` · \$\{MISSED_RECORD_MARK\}` : ""\}`;/, "and marks it beside the misses");
  }

  // ── 6 · The gate: the Super Admin alone, for a rep who exists, on a line that has opened ────────
  {
    const real = territoryForMissedRecord(viewer(), REP.seatId, false);
    assert.equal(real.isTest, false, "with test mode off the record is real — his second real-data write");
    assert.equal(real.repHrId, "B-7", "entered FOR the territory's rep");
    assert.equal(territoryForMissedRecord(viewer(), REP.seatId, true).isTest, true, "with test mode on it is a test entry");

    refused(() => territoryForMissedRecord(viewer(), VACANT.seatId, false), /no rep/, "a vacant seat has nobody to enter a record for");
    refused(() => territoryForMissedRecord(viewer(), CLOSED_LINE.seatId, false), /not open|opens for/, "a line that has not opened has nothing to have missed");
    assert.equal(territoryForMissedRecord(viewer(), CLOSED_LINE.seatId, true).isTest, true, "a test entry reaches any territory, as all of his do");
    refused(() => territoryForMissedRecord(viewer(), DM.seatId, false), /not in the organogram/, "a territory, never a manager's seat");

    const nobodyElse: Array<[string, Partial<PhoenixCrmViewer>]> = [
      ["the SFE Manager", { role: "SFE Manager", isSuperAdmin: false, isSfeManager: true }],
      ["the CEO", { role: "CEO", isSuperAdmin: false }],
      ["the territory's district manager", { role: "District Manager", isSuperAdmin: false, hrId: "B-12", basis: "tree" }],
      ["a test account", { isTestPersona: true }],
      ["a Super Admin whose matrix row cannot update", { canUpdate: false }],
    ];
    for (const [who, patch] of nobodyElse) {
      refused(() => territoryForMissedRecord(viewer(patch), REP.seatId, false), /Only the Super Admin/, `${who} enters no missed record`);
      assert.equal(canEnterMissedRecords(viewer(patch)), false, `${who}: no panel, no open cells`);
    }

    // The screen's twin answers the same question, without throwing.
    assert.equal(canEnterMissedRecordOn(viewer(), REP, false), true);
    assert.equal(canEnterMissedRecordOn(viewer(), VACANT, false), false);
    assert.equal(canEnterMissedRecordOn(viewer(), CLOSED_LINE, false), false);
    assert.equal(canEnterMissedRecordOn(viewer(), CLOSED_LINE, true), true);
    assert.equal(canEnterMissedRecordOn(viewer({ isTestPersona: true }), REP, true), false);
  }

  // ── 7 · It adds what is missing, and never rewrites what the rep recorded ───────────────────────
  {
    const service = source("src/lib/phoenix-crm/server/missed-records.ts");
    for (const entry of ["loadMissedRecordForm", "enterMissedVisit", "enterMissedActivity"]) {
      const at = service.indexOf(`export async function ${entry}(`);
      assert.ok(at >= 0, `${entry} still exists`);
      const body = service.slice(at, service.indexOf("\n}\n", at));
      assert.match(body, /territoryForMissedRecord\(viewer, (raw|body)\.seatId, readTestFlag\((raw|body)\.test\)\)/, `${entry} passes the gate first`);
    }
    assert.match(
      service,
      /if \(existing && !existing\.enteredByAdmin\) \{\s*throw conflictError\(/,
      "a day the rep recorded himself stays his: the Super Admin changes or clears only what he entered",
    );
    assert.match(service, /planned: entry\.planned,/, "HIS choice reaches the database as he made it");
    assert.match(service, /if \(!entry\.planned && !duplicate\) \{\s*await notifyPhoenixCrm\(/, "an unplanned entry tells the deciding manager, once");
    assert.match(service, /enteredByAdmin: true,/, "and the notice says whose reason it is");

    // The ONLY place a day activity is back-dated, and why it may be: the rep's own save keeps his
    // visit day (tests/phoenix-crm-day-activities pins that), and this is the Super Admin's entry of a
    // day the rep missed, behind the gate above.
    assert.match(service, /activity_date: entry\.activityDate,/);

    // Speed (Phoenix CRM performance audit, 2026-10-16). The form's reads start BESIDE the mint and only
    // the customer list waits on it — the mint can add customers, and nothing else can name one minted a
    // moment ago — and the mint's own failure is still the one that surfaces, first.
    const formAt = service.indexOf("export async function loadMissedRecordForm(");
    const form = service.slice(formAt, service.indexOf("\n}\n", formAt));
    assert.match(form, /ensured\.then\(\(\) => loadTerritoryCustomers\(seat\.seatId, isTest, \{ onListOnly: true \}\)\)/, "the customer list is read after the mint");
    const mintAwaitedAt = form.indexOf("await ensured;");
    const waveAwaitedAt = form.indexOf("= await wave;");
    assert.ok(mintAwaitedAt > 0 && waveAwaitedAt > mintAwaitedAt, "the mint is awaited before the wave, so its failure is the one he reads");
    // The day activity he saves is shaped from the save's own answer, not read back: the function stores
    // `actor_hr_id` as the entered-by and `rep_hr_id` as the rep, verbatim, and returns neither.
    assert.match(
      service,
      /mapDayActivityRow\(\{ \.\.\.saved, entered_by_hr_id: viewer\.hrId, rep_hr_id: repHrId \}\)/,
      "the 'entered for him' mark is the one a read-back would compute",
    );
  }

  // ── 8 · An entered visit has NO location, and nothing that judges a rep reads it as one ────────
  {
    const migration = source("supabase/migrations/20261001044221_phoenix_crm_admin_entry.sql");
    assert.match(migration, /check \(capture_source in \('slot', 'offline_anchor', 'server', 'admin'\)\)/);
    assert.match(
      migration,
      /add constraint phoenix_crm_visits_location_source check \(\s*\(lat is null\) = \(lon is null\)\s*and \(lat is not null or capture_source = 'admin'\)\s*\)/,
      "a missing location is the Super Admin's entry and nobody else's — every other visit still needs both",
    );
    assert.match(migration, /if v_date > v_running_day then\s*raise exception 'phoenix_crm:future_day';/, "never a day still to come");
    assert.match(migration, /null, null, null, null, null, 'no_place', v_is_test,/, "no reading, no place, no distance");
    assert.match(migration, /not v_planned, case when v_planned then null else 'out_of_plan' end, 'admin', now\(\)/, "his choice, marked admin");
    assert.match(migration, /if v_existing\.capture_source = 'admin'[\s\S]{0,1200}'duplicate', true/, "the same entry sent twice answers with the visit already saved");

    // 🔴 The coordinate read. `Number(null)` is 0, which is finite: a missing reading became a fix at
    // 0°N 0°E and the rep's next real visit read as impossible travel from the Gulf of Guinea.
    const integrity = source("src/lib/phoenix-crm/server/location-integrity.ts");
    assert.match(integrity, /function coordinate\(value: unknown\): number \| null \{\s*if \(value === null \|\| value === undefined \|\| value === ""\) return null;/);
    assert.match(integrity, /const lat = coordinate\(row\.lat\);\s*const lon = coordinate\(row\.lon\);/, "a prior fix is read through it");
    assert.doesNotMatch(integrity, /Number\(row\.lat\)|Number\(row\.lon\)/, "and never through a bare Number()");
    assert.match(integrity, /\.gte\("captured_at", ownSince\)\s*\.not\("lat", "is", null\)/, "the rep's own history reads visits with a reading only");

    const behaviour = source("src/lib/phoenix-crm/server/behaviour.ts");
    assert.match(behaviour, /\.eq\("is_test", false\)\s*\.neq\("capture_source", "admin"\)/, "the behaviour sweep never judges the Super Admin's entry as the rep's own work");

    const reports = source("src/lib/phoenix-crm/server/reports.ts");
    const locationReport = reports.slice(reports.indexOf("export async function loadVisitLocationReport("));
    assert.match(
      locationReport.slice(0, locationReport.indexOf("\n}\n")),
      /\.lte\("visit_date", period\.to\)\s*\.neq\("capture_source", "admin"\)\s*\.is\("linked_from_visit_id", null\);/,
      "place against actual has no actual for an entered visit — nor for the pharmacy visit a doctor's visit filed beside itself",
    );
  }

  // ── 9 · Where he enters it: the day's own page, opened from the calendar ────────────────────────
  {
    const calendar = source("src/components/phoenix-crm/calendar-tab.tsx");
    assert.equal(
      (calendar.match(/const opens = cellOpens\(row, day, entrySeats, entryThrough\);/g) ?? []).length,
      2,
      "both grids — the desktop row and the phone card — open his days the same way",
    );
    // The one rule behind both: a rep row opens on work or, for the Super Admin, to enter one; a manager row opens
    // on a day he worked and — since 2026-10-24 ("Visits and days") — for the Super Admin on any day that has begun.
    assert.match(
      calendar,
      /if \(row\.kind === "manager"\) return opensTheDay\(day\) \|\| \(entryThrough !== null && opensForMissedRecords\(day\.day, entryThrough\)\);\s*return opensTheDay\(day\) \|\| opensForEntry\(entrySeats, entryThrough, row\.seatId, day\);/,
      "a manager cell opens for entry only for the Super Admin (entryThrough is null for everyone else); a rep cell as before",
    );
    const calendarService = source("src/lib/phoenix-crm/server/team-calendar.ts");
    assert.match(
      calendarService,
      /const missedRecords = canEnterMissedRecords\(viewer\)\s*\?\s*\{ through: viewer\.visitDay, seatIds: seats\.filter\(\(seat\) => canEnterMissedRecordOn\(viewer, seat, isTest\)\)\.map\(\(seat\) => seat\.seatId\) \}\s*:\s*null;/,
      "the calendar names his territories from the same rule the save asserts",
    );
    const detail = source("src/lib/phoenix-crm/server/day-detail.ts");
    assert.match(detail, /seat && canEnterMissedRecordOn\(viewer, seat, day\.isTest\) && isMissedRecordDay\(day\.date, viewer\.visitDay\)/);
    const view = source("src/components/phoenix-crm/day-detail-view.tsx");
    assert.match(view, /\{view\.missedRecords \? \(\s*<MissedRecordPanel/, "the panel is drawn only where the server said so");
    // The reason he typed reads back on the day page, as on the Visits tab — not the status sentence.
    assert.match(
      view,
      /Off the plan because: <\/span>\s*<span dir="auto">\{visit\.unplanned\.clarification\}<\/span>/,
      "the day page shows WHY the visit was off the plan",
    );
    const panel = source("src/components/phoenix-crm/missed-record-panel.tsx");
    assert.equal(
      (panel.match(/crmPost<[^>]+>\("\/api\/phoenix-crm\/missed-records"/g) ?? []).length,
      3,
      "a visit, a day activity, and clearing one (taking a visit back is the Super Admin delete since 2026-10-23)",
    );
    assert.match(panel, /setPlanned\(next\.onSentPlan \? "planned" : "unplanned"\);/, "it starts from the plan, and he turns it either way");
  }

  // ── 10 · Taking back a visit he entered by mistake (owner, 2026-10-01) ─────────────────────────
  {
    const parsed = parseRemoveMissedVisit({ visitId: VISIT_ID.toUpperCase() });
    assert.ok(parsed.ok && parsed.value.visitId === VISIT_ID, "the visit is named by its id, as stored");
    assert.equal(parseRemoveMissedVisit({ visitId: "not-a-uuid" }).ok, false);
    assert.equal(parseRemoveMissedVisit({}).ok, false);

    // The Super Admin alone — and WITHOUT the entry's rep-and-open-line conditions: his own mistake stays
    // his to take back after the rep has left the seat or the line has closed again.
    assert.equal(territoryForMissedRecordRemoval(viewer(), REP.seatId, false).isTest, false);
    assert.equal(territoryForMissedRecordRemoval(viewer(), VACANT.seatId, false).seat.seatId, VACANT.seatId, "a seat the rep has left");
    assert.equal(territoryForMissedRecordRemoval(viewer(), CLOSED_LINE.seatId, false).seat.seatId, CLOSED_LINE.seatId, "a line closed again");
    const nobodyElse: Array<[string, Partial<PhoenixCrmViewer>]> = [
      ["the SFE Manager", { role: "SFE Manager", isSuperAdmin: false, isSfeManager: true }],
      ["the CEO", { role: "CEO", isSuperAdmin: false }],
      ["the territory's district manager", { role: "District Manager", isSuperAdmin: false, hrId: "B-12", basis: "tree" }],
      ["a test account", { isTestPersona: true }],
      ["a Super Admin whose matrix row cannot update", { canUpdate: false }],
    ];
    for (const [who, patch] of nobodyElse) {
      refused(() => territoryForMissedRecordRemoval(viewer(patch), REP.seatId, false), /Only the Super Admin/, `${who} removes no visit`);
    }

    // 🔴 WHICH visit may go is the DATABASE's to decide, from the row: his entry and nobody else's, and a
    // copy of everything before a single row is deleted — production has no point-in-time recovery.
    const removal = source("supabase/migrations/20261001055833_phoenix_crm_admin_remove_visit.sql");
    assert.match(
      removal,
      /if v_visit\.capture_source <> 'admin' or v_visit\.entered_by_hr_id is distinct from v_actor then\s*raise exception 'phoenix_crm:not_entered_by_you';/,
      "a rep's own visit, or another person's entry, is refused",
    );
    const copyAt = removal.indexOf("insert into public.phoenix_crm_removed_visits");
    const eventsAt = removal.indexOf("delete from public.phoenix_crm_unplanned_visit_events where visit_id = v_id;");
    const approvalAt = removal.indexOf("delete from public.phoenix_crm_unplanned_visits where visit_id = v_id;");
    const visitAt = removal.indexOf("delete from public.phoenix_crm_visits where id = v_id;");
    assert.ok(copyAt > 0 && copyAt < eventsAt && eventsAt < approvalAt && approvalAt < visitAt, "the copy first, then the children, then the visit");
    assert.match(removal, /to_jsonb\(v_visit\), v_unplanned, v_events/, "the copy holds the visit, its approval and the approval's events");

    // The service passes the gate first and sends him as the one asking; the route takes it as a record kind.
    const service = source("src/lib/phoenix-crm/server/missed-records.ts");
    const remove = service.slice(service.indexOf("export async function removeMissedVisit("));
    assert.match(remove, /territoryForMissedRecordRemoval\(viewer, body\.seatId, readTestFlag\(body\.test\)\)/);
    assert.match(remove, /p: \{ visit_id: parsed\.value\.visitId, seat_id: seat\.seatId, actor_hr_id: viewer\.hrId, is_test: isTest \}/);
    const route = source("app/api/phoenix-crm/missed-records/route.ts");
    assert.match(route, /if \(body\.record === "remove-visit"\) \{\s*const removed = await removeMissedVisit\(viewer, body\);/);

    // On the day page, the button that takes a visit back is the Super Admin's delete (owner, 2026-10-23),
    // drawn on EVERY visit; this older function still refuses a rep's visit if anything ever calls it.
    const view = source("src/components/phoenix-crm/day-detail-view.tsx");
    assert.match(view, /view\.adminDeletes \? \(\s*<AdminDelete id=\{visit\.visitId\}[^>]*kind="visit"/, "Delete is drawn on every visit for the Super Admin");
    const detail = source("src/lib/phoenix-crm/server/day-detail.ts");
    assert.match(detail, /adminDeletes: canEnterMissedRecords\(viewer\)/);
  }

  // ── 11 · The notice goes with the visit (owner, 2026-10-02) ────────────────────────────────────
  {
    // Both notices a visit can raise are built from the SAME prefix the withdrawal searches by, so a
    // renamed key cannot leave one behind — and the keys stay byte-for-byte what they were, or the
    // idempotency of every notice already sent breaks.
    const prefix = phoenixCrmVisitNoticeKeyPrefix(VISIT_ID);
    assert.equal(prefix, `phoenix_crm:unplanned:${VISIT_ID}:`);
    assert.equal(`${prefix}raised`, `phoenix_crm:unplanned:${VISIT_ID}:raised`, "the key production already wrote");
    const crmNotices = source("src/lib/phoenix-crm/server/notifications.ts");
    // 🔴 THE KEY IS STILL `${prefix}raised` FOR THE MANAGER'S COPY — the value is what must not move,
    // and only its SPELLING did. Since 2026-10-02 the raised branch also addresses the SFE Managers
    // when the territory's manager chain is vacant, so the step rides in the key through a ternary:
    // `raised` where a reviewer exists, `sfe_pending` where none does, which is the same key the
    // decided branch writes when a manager passes a visit on. Pinning the old literal would have
    // forced that ternary back out and told SFE twice about the same visit.
    assert.match(
      crmNotices,
      /idempotencyKey: `\$\{phoenixCrmVisitNoticeKeyPrefix\(notice\.visitId\)\}\$\{reviewer \? "raised" : "sfe_pending"\}`/,
      "the manager's copy still keys on `raised`, byte for byte",
    );
    assert.match(crmNotices, /idempotencyKey: `\$\{phoenixCrmVisitNoticeKeyPrefix\(notice\.visitId\)\}sfe_pending`/, "and the SFE step has one key, however it got there");
    assert.match(crmNotices, /idempotencyKey: `\$\{phoenixCrmVisitNoticeKeyPrefix\(notice\.visitId\)\}v\$\{notice\.version\}:\$\{notice\.status\}`/);

    // Removing withdraws them, and only AFTER the database agreed the visit could go at all.
    const service = source("src/lib/phoenix-crm/server/missed-records.ts");
    const remove = service.slice(service.indexOf("export async function removeMissedVisit("));
    // ONCE, and after the database call — counted as well as ordered, because an extra call added
    // ahead of the removal leaves the later one in place and an ordering test alone reads as fine.
    assert.equal((remove.match(/withdrawPhoenixCrmVisitNotices\(/g) ?? []).length, 1, "withdrawn once");
    assert.ok(
      remove.indexOf('callPhoenixCrm<Row>("phoenix_crm_admin_remove_visit"') < remove.indexOf("withdrawPhoenixCrmVisitNotices("),
      "the removal runs first — withdrawing before it would take a notice back from a manager whose visit is still there",
    );

    // The real withdrawal, against rows shaped like the real tables.
    const other = "11111111-2222-3333-4444-555555555555";
    const event = (id: string, key: string, hrId: string) => ({ employee_hr_id: hrId, event_key: key, id, recipient_user_id: `user-${hrId}` });
    const client = fakeSupabaseClient(
      {
        notification_events: [
          event("n1", `phoenix_crm:unplanned:${VISIT_ID}:raised`, "B-12"),
          event("n2", `phoenix_crm:unplanned:${VISIT_ID}:v1:approved`, "B-7"),
          event("n3", `phoenix_crm:unplanned:${VISIT_ID}:raised:test:TEST-SFE-1`, "B-12"),
          event("n4", `phoenix_crm:unplanned:${other}:raised`, "B-12"),
          // `_` is a LIKE wildcard and every key here contains `phoenix_crm`, so an unescaped prefix
          // would clear this one too — a notice about a visit nobody touched.
          event("n5", `phoenixXcrm:unplanned:${VISIT_ID}:raised`, "B-12"),
        ],
        // The viewer's own row, in the shape this table stores: `archiveInAppNotification` and
        // `markInAppNotificationRead` both key it by normalizeHrId — the lowercase canonical id.
        notification_user_states: [
          { archived_at: null, hr_id: "b-7", id: "state-1", notification_event_id: "n2", read_at: "2026-10-02T06:00:00.000Z" },
        ],
      },
      { projectColumns: true },
    );

    const withdrawn = await withdrawInAppNotificationsByEventKeyPrefix(prefix, client as never);
    assert.equal(withdrawn.withdrawn, 3, "the manager's, the rep's, and the test-world copy");

    const states = client.rows("notification_user_states");
    const stateFor = (eventId: string) => states.find((row) => row.notification_event_id === eventId);
    for (const eventId of ["n1", "n2", "n3"]) assert.ok(stateFor(eventId)?.archived_at, `${eventId} leaves the bell`);
    assert.equal(stateFor("n4"), undefined, "a notice about another visit is untouched");
    assert.equal(stateFor("n5"), undefined, "`_` is escaped, so a lookalike key is not swept up");
    // 🔴 THE CANONICAL LOWERCASE ID, which is what makes the withdrawal land at all: the bell reads
    // this table by normalizeHrId, so writing the event's raw "B-12" would add a SECOND row the
    // manager's own read never matches, and the notice would stay on his bell looking untouched.
    assert.equal(stateFor("n1")?.hr_id, "b-12", "archived for the person the event names, in the form the table is keyed by");
    assert.equal(stateFor("n1")?.user_id, "user-B-12");
    // The row already there is UPDATED, not duplicated, and what he had read survives: the conflict
    // target is (notification_event_id, hr_id).
    assert.equal(states.filter((row) => row.notification_event_id === "n2").length, 1, "one state row per person per notice");
    assert.equal(stateFor("n2")?.read_at, "2026-10-02T06:00:00.000Z", "withdrawing does not erase what he had already read");
    assert.equal(client.rows("notification_events").length, 5, "ARCHIVED, never deleted — the event rows stay for the audit");

    // A PLANNED entry raises no notice at all, so the ordinary case is a no-op rather than a branch.
    assert.deepEqual(
      await withdrawInAppNotificationsByEventKeyPrefix(phoenixCrmVisitNoticeKeyPrefix(other), fakeSupabaseClient({ notification_events: [] }) as never),
      { withdrawn: 0 },
    );
    assert.deepEqual(
      await withdrawInAppNotificationsByEventKeyPrefix("   ", client as never),
      { withdrawn: 0 },
      "an empty prefix clears nothing — it would otherwise match every notice in the system",
    );

    // It never throws into the caller: the visit is already gone, so a failed withdrawal must not
    // turn a finished removal into an error on his screen.
    await withdrawPhoenixCrmVisitNotices(VISIT_ID, fakeSupabaseClient({}, { failOn: { notification_events: "boom" } }) as never);
  }

  console.log("phoenix-crm missed records: OK");
}
