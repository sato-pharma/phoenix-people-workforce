import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import {
  enforcePhoenixCrmEmailBlock,
  PHOENIX_CRM_EMAIL_EVENT_TYPES,
  phoenixCrmChannels,
} from "../src/lib/notifications/phoenix-crm-channel-guard.ts";
import {
  canStartDay,
  DAY_START_BUTTON_LABEL,
  DAY_START_BUTTON_NOTE,
  DAY_START_LOCATION_NOTE,
  DAY_START_READ_LABEL,
  dayStartReadLine,
  minuteClock,
} from "../src/lib/phoenix-crm/day-start-rules.ts";
import { buildOrgIndex, type OrgSeat } from "../src/lib/phoenix-crm/scope.ts";
import { emptyTeamToday, teamTodayLine } from "../src/lib/phoenix-crm/team-today.ts";
import { dayStartDeliveries } from "../src/lib/phoenix-crm/server/notifications.ts";

/**
 * Phoenix CRM — "Show your manager you started working" (owner, 2026-10-03).
 *
 * His words: *"i want to make an feature for medical reps to confirm they started their work bec as u
 * know the visit is entered after it is done so i want to know when actually did they start working.
 * only before the first AM visit show them an obvious clean button called show your manager u started
 * working and under this button write press here before doing only the first AM visit and confirm
 * before not after. after the rep press on this the managers is informed by in app telegram and
 * email"* — and then: *"when they press the button their location and their time send to managers and
 * saved in system"*.
 *
 * What this file pins, each of which goes wrong QUIETLY:
 *
 *   (a) WHEN THE BUTTON EXISTS. Only the territory's own rep, only today, only before his first AM
 *       visit, only once. A button that survives the first AM visit records the time he REMEMBERED,
 *       which is the one figure the whole feature exists to avoid.
 *   (b) WHO IS TOLD — his district manager and the SFE Manager (his pick), never the rep himself.
 *   (c) THE TWO EVENT TYPES, which are the only thing holding "email to the DM only". They are one
 *       edit away from collapsing into one type, and the collapse is invisible until the SFE's inbox
 *       takes one email per rep per morning — about 74 company-wide.
 *   (d) THE BUTTON SAYS THE LOCATION TRAVELS. Every other reading in this module is silent because it
 *       is a check on the rep; this one is a report he makes, and that distinction only holds while he
 *       can read it before pressing.
 *   (e) THE SERVER TAKES NEITHER THE DAY NOR THE TIME FROM THE PHONE — the same closure the module put
 *       on back-dating a visit, and here it is the entire point of the feature.
 *   (f) THE MANAGERS' OWN SCREENS READ IT, and a day with NO start says nothing at all (owner,
 *       2026-10-03: "show the day start time on the manager's team day screen too"). The press was
 *       never required and never blocks a visit, so an "it was not confirmed" sentence would put a
 *       flag on every row before the first press of the morning — and on every day that passed before
 *       the button existed.
 */

const ROOT = new URL("../", import.meta.url);

function source(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8"));
}

function seat(overrides: Partial<OrgSeat> & Pick<OrgSeat, "seatId" | "tier" | "path">): OrgSeat {
  return {
    parentSeatId: overrides.path.length > 1 ? overrides.path[overrides.path.length - 2] : null,
    occupantHrId: null,
    lineCode: "pedia",
    lineName: "Pedia",
    areaName: null,
    regionName: null,
    seatLabel: null,
    ...overrides,
  };
}

const CEO = seat({ seatId: "SEAT-CEO", tier: "CEO", path: ["SEAT-CEO"], occupantHrId: "B-2", lineCode: null, lineName: null });
const NSM = seat({ seatId: "SEAT-PED-NSM", tier: "NSM", path: ["SEAT-CEO", "SEAT-PED-NSM"], occupantHrId: "A-12" });
const DM1 = seat({ seatId: "SEAT-PED-DM-D1", tier: "DM", path: [...NSM.path, "SEAT-PED-DM-D1"], occupantHrId: "B-40", regionName: "Delta (1)" });
const REP1 = seat({ seatId: "SEAT-PED-REP-D11", tier: "REP", path: [...DM1.path, "SEAT-PED-REP-D11"], occupantHrId: "B-7", areaName: "Tanta", regionName: "Delta (1)" });
// A vacant district: the notice must pass upward rather than reach nobody.
const DMV = seat({ seatId: "SEAT-PED-DM-GZ", tier: "DM", path: [...NSM.path, "SEAT-PED-DM-GZ"], occupantHrId: null, regionName: "Giza" });
const REPV = seat({ seatId: "SEAT-PED-REP-GZ11", tier: "REP", path: [...DMV.path, "SEAT-PED-REP-GZ11"], occupantHrId: "B-80", areaName: "Dokki", regionName: "Giza" });
// An acting district manager who is ALSO the rep of a seat under his own: he must never be told about himself.
const ADM = seat({ seatId: "SEAT-PED-ADM-D2", tier: "ACTING_DM", path: [...NSM.path, "SEAT-PED-ADM-D2"], occupantHrId: "B-1", regionName: "Delta (2)" });
const REPA = seat({ seatId: "SEAT-PED-REP-D21", tier: "REP", path: [...ADM.path, "SEAT-PED-REP-D21"], occupantHrId: "B-1", areaName: "Mansoura", regionName: "Delta (2)" });

const org = buildOrgIndex([CEO, NSM, DM1, REP1, DMV, REPV, ADM, REPA]);
const SFE = ["B-150", "B-151"];
const NAMES = new Map([
  ["B-7", "Aya Ibrahim"],
  ["B-80", "Nour Hassan"],
  ["B-1", "Omar Sabry"],
]);

/** 08:42 Cairo on Saturday 3 October 2026 — the first morning Delta (1) works on the module. */
const STARTED_AT = "2026-10-03T05:42:09.000Z";

function notice(repSeat: OrgSeat, repHrId: string, plannedAmMinute: number | null = 8 * 60) {
  return {
    kind: "day_start" as const,
    org,
    seat: repSeat,
    repHrId,
    startedAt: STARTED_AT,
    lat: 30.7865,
    lon: 31.0004,
    plannedAmMinute,
  };
}

export function runPhoenixCrmDayStartTests(): void {
  // ── (a) When the button exists ─────────────────────────────────────────────────────────────────
  {
    const base = { viewerIsRep: true, isToday: true, amVisits: 0, alreadyStarted: false };
    assert.equal(canStartDay(base), true, "his own territory, today, before any AM visit: he may press it");
    assert.equal(canStartDay({ ...base, amVisits: 1 }), false, "🔴 once an AM visit is saved the button is GONE — it would record the time he remembered");
    assert.equal(canStartDay({ ...base, amVisits: 3 }), false, "and it stays gone for the rest of the day");
    assert.equal(canStartDay({ ...base, alreadyStarted: true }), false, "pressed once is pressed: a day has one start");
    assert.equal(canStartDay({ ...base, isToday: false }), false, "never on a day he is only reading back");
    assert.equal(canStartDay({ ...base, viewerIsRep: false }), false, "never a manager: it is a statement about the rep's own morning");

    // A PM-only morning still offers it: the rule is "before the first AM visit", and a rep with no AM
    // customers has not had one. Nothing here reads his plan.
    assert.equal(canStartDay({ ...base, amVisits: 0 }), true, "a day with no AM customers still offers it");
  }

  // ── (b) Who is told ────────────────────────────────────────────────────────────────────────────
  {
    const deliveries = dayStartDeliveries(notice(REP1, "B-7"), NAMES, SFE);
    assert.equal(deliveries.length, 2, "two deliveries: the district manager, and the SFE Managers");

    const dm = deliveries.find((entry) => entry.eventType === "day_start_confirmed");
    const sfe = deliveries.find((entry) => entry.eventType === "day_start_seen");
    assert.ok(dm && sfe, "one of each type");
    assert.deepEqual(dm.recipients, ["B-40"], "his district manager, and nobody above him");
    assert.deepEqual(sfe.recipients.sort(), ["B-150", "B-151"], "and the SFE Managers, who hold a role with no seat");
    assert.equal(dm.recipients.includes("A-12"), false, "the national sales manager is NOT told: this is a daily notice, not the once-ever first visit");

    // A vacant district passes upward, exactly as a grade request and a weekly plan do.
    const vacant = dayStartDeliveries(notice(REPV, "B-80"), NAMES, SFE);
    const vacantDm = vacant.find((entry) => entry.eventType === "day_start_confirmed");
    assert.deepEqual(vacantDm?.recipients, ["A-12"], "a vacant district seat passes to the manager above it, so somebody is told rather than nobody");

    // 🔴 NEVER THE REP, even when he holds the manager seat above his own rep seat. `managerChain`
    // already skips a seat the rep himself holds, so an acting district manager's own start passes
    // UPWARD to the manager above him — somebody is told rather than nobody, exactly as a vacant
    // district behaves, and he is never sent a notice about himself.
    const acting = dayStartDeliveries(notice(REPA, "B-1"), NAMES, SFE);
    for (const delivery of acting) {
      assert.equal(delivery.recipients.includes("B-1"), false, "an acting district manager is never told about his own start");
    }
    const actingDm = acting.find((entry) => entry.eventType === "day_start_confirmed");
    assert.deepEqual(actingDm?.recipients, ["A-12"], "it passes to the manager above his own acting seat");

    // One start per rep per day: the key carries the person and the date, never the row.
    assert.match(dm.idempotencyKey, /^phoenix_crm:day_start:B-7:2026-10-03:dm$/, "keyed on the rep and the day, so a retry tells nobody twice");
    assert.match(sfe.idempotencyKey, /^phoenix_crm:day_start:B-7:2026-10-03:sfe$/, "and the SFE's copy has its own key, so neither overwrites the other");
  }

  // ── (c) The two event types are what hold "email to the district manager only" ──────────────────
  {
    assert.ok(PHOENIX_CRM_EMAIL_EVENT_TYPES.includes("day_start_confirmed"), "the district manager's copy may email");
    assert.equal(PHOENIX_CRM_EMAIL_EVENT_TYPES.includes("day_start_seen"), false, "🔴 the SFE's copy may NOT — it would be one email per rep every morning");

    assert.ok(phoenixCrmChannels("day_start_confirmed").includes("email"), "the DM gets email");
    assert.deepEqual(
      phoenixCrmChannels("day_start_seen"),
      ["in_app", "telegram"],
      "🔴 the SFE gets in-app and Telegram and nothing else — on the push-blocked list, so the Telegram-failure fallback cannot mail him either",
    );

    // The guard is the enforcement, not the call site: email re-enters from the fallback.
    assert.ok(
      enforcePhoenixCrmEmailBlock(["email", "in_app"], "phoenix_crm", "day_start_confirmed").includes("email"),
      "the DM's copy keeps email through the guard",
    );
    assert.equal(
      enforcePhoenixCrmEmailBlock(["email", "in_app"], "phoenix_crm", "day_start_seen").includes("email"),
      false,
      "and the SFE's is stripped of it even when the pipeline asks for email",
    );
  }

  // ── The words the managers read ────────────────────────────────────────────────────────────────
  {
    const [dm] = dayStartDeliveries(notice(REP1, "B-7"), NAMES, SFE);
    assert.match(dm.title, /^Started working: Aya Ibrahim$/, "the title names the person, never an id");
    assert.match(dm.message, /Aya Ibrahim confirmed they started working at .+ \(Cairo\)/, "the time, in Cairo");
    assert.match(dm.message, /Their plan said they would start the morning at 08:00\./, "and what his plan said, so the manager reads planned against actual");
    assert.match(dm.message, /google\.com\/maps\/search\/\?api=1&query=30\.7865,31\.0004/, "and where he was — the owner's ruling that the location travels");

    const noPlan = dayStartDeliveries(notice(REP1, "B-7", null), NAMES, SFE)[0];
    assert.match(noPlan.message, /They had no sent plan for today\./, "a rep who started a day he never planned says so, rather than hiding the gap");

    assert.equal(minuteClock(8 * 60), "08:00");
    assert.equal(minuteClock(9 * 60 + 5), "09:05");
  }

  // ── (d) The button tells him his location travels, BEFORE he presses ───────────────────────────
  {
    const rules = source("src/lib/phoenix-crm/day-start-rules.ts");
    const button = source("src/components/phoenix-crm/day-start-button.tsx");

    assert.equal(DAY_START_BUTTON_LABEL, "Show your manager you started working", "the owner's own words on the button");
    assert.match(DAY_START_BUTTON_NOTE, /before your first AM visit — before it, not after/, "and his own instruction under it");
    assert.match(DAY_START_LOCATION_NOTE, /see the time and where you are/, "🔴 the press says the location travels — it is a report he makes, not a check on him");

    assert.ok(button.includes("{DAY_START_LOCATION_NOTE}"), "and the button renders that line");
    // Read from the rules rather than retyped, so the wording cannot drift from what the rule says.
    for (const name of ["DAY_START_BUTTON_LABEL", "DAY_START_BUTTON_NOTE", "DAY_START_LOCATION_NOTE"]) {
      assert.ok(button.includes(name), `the button uses ${name} rather than its own copy of the words`);
    }
    assert.equal(button.includes('"Show your manager'), false, "and never retypes the label as a literal");
    assert.ok(rules.includes("DAY_START_LOCATION_NOTE"), "the sentence lives with the rule, so a screen cannot quietly drop it");

    // Square corners and no ellipsis, like every other CRM screen.
    const rounded = [...button.matchAll(/(?<![\w-])rounded(?:-[\w./[\]-]+)?(?![\w-])/g)].map((match) => match[0]).filter((token) => token !== "rounded-none");
    assert.deepEqual(rounded, [], "the day-start block rounds no corner");
    assert.equal(/\b(truncate|text-ellipsis|line-clamp-\d)\b/.test(button), false, "and cuts no text short");
  }

  // ── (e) The server trusts neither the phone's clock nor its date ───────────────────────────────
  {
    const service = source("src/lib/phoenix-crm/server/day-start.ts");
    // The WRITE only. The read may take a date — that is the day screen looking back at an earlier
    // day, which is exactly what a manager reading "did he start on Tuesday" needs.
    const write = service.slice(service.indexOf("export async function startDay("), service.indexOf("export async function loadDayStart("));
    assert.ok(write.length > 200, "startDay was found");
    assert.ok(write.includes("territoryForRepWrite"), "the write is the territory's own rep's");
    assert.ok(write.includes("viewer.visitDay"), "the day comes from the viewer's visit day");
    assert.equal(/started_at:/.test(write), false, "🔴 the write never sends a start time: the database's own now() stamps it");
    assert.equal(/raw\.date|body\.date|started_on:/.test(write), false, "and never takes the day from the body");
    assert.ok(write.includes("if (created)"), "the managers are told on the press that started the day, not on a repeat");

    const migration = readFileSync(new URL("supabase/migrations/20261003075803_phoenix_crm_day_starts.sql", ROOT), "utf8");
    assert.match(migration, /started_at timestamptz not null default now\(\)/, "the server clock is the default, in the table itself");
    assert.match(migration, /\(\(now\(\) at time zone 'Africa\/Cairo'\) - interval '2 hours'\)::date/, "and the visit day is the module's 02:00 rule, not the calendar date");
    assert.match(migration, /create unique index[\s\S]*?\(seat_id, started_on, is_test\)/, "one start per rep per day, per world — what makes the press idempotent");
    assert.match(
      migration,
      /revoke execute on function public\.phoenix_crm_start_day\(jsonb\) from public, anon, authenticated;/,
      "and the RPC is revoked from the browser roles, which inherit EXECUTE through PUBLIC",
    );
  }

  // ── (f) The managers' screens, and the silence of a day with no start ──────────────────────────
  {
    assert.equal(DAY_START_READ_LABEL, "Started working", "the managers' screens call it what the button called it");
    assert.equal(
      dayStartReadLine({ startedAt: STARTED_AT, plannedAmMinute: 8 * 60 }, "08:42"),
      "08:42 · their plan said 08:00",
      "the day in full prints the clock beside what his own sent plan had said",
    );
    assert.equal(
      dayStartReadLine({ startedAt: STARTED_AT, plannedAmMinute: null }, "08:42"),
      "08:42 · they had no sent plan for this day",
      "a rep who started a day he never planned says so on the manager's screen, exactly as the notice does",
    );

    // The Team tab's one line: the start OPENS it, and the figures behind it are untouched.
    const figures = { ...emptyTeamToday(), planSent: true, amPlanned: 2, amPlannedDone: 1, amLogged: 1 };
    assert.equal(
      teamTodayLine(figures, "09:30", "08:42"),
      "Started 08:42 · Planned AM 1 of 2 · PM none planned · logged 1 AM · 0 PM, last at 09:30",
      "when he pressed it, his managers read it first on the row",
    );
    // 🔴 NO "NOT STARTED" HALF, ANYWHERE. This is the assertion that keeps a voluntary report from
    // turning into a flag: before the first press of a morning every row would carry one.
    assert.equal(
      teamTodayLine(figures, "09:30", null),
      teamTodayLine(figures, "09:30"),
      "no press, no half — the line is exactly what it was before this feature",
    );
    assert.equal(/start/i.test(teamTodayLine(figures, "09:30", null)), false, "and the word does not appear at all without a press");
    assert.equal(
      /start/i.test(teamTodayLine(emptyTeamToday(), null, null)),
      false,
      "including on a rep with no plan and no visit yet, which is every row at seven in the morning",
    );

    const page = source("src/components/phoenix-crm/day-detail-view.tsx");
    assert.ok(page.includes("dayStartReadLine(dayStart"), "the day in full prints it through the rule, never its own wording");
    assert.ok(page.includes("{DAY_START_READ_LABEL}"), "and labels it from the rule as well");
    assert.ok(page.includes("{dayStart ? ("), "shown only when he pressed it");
    assert.equal(
      /not confirmed|did not press|no start/i.test(page),
      false,
      "🔴 a day with no start is a MISSING LINE, never a sentence written against him",
    );

    // One batched read for the whole scope — an SFE Manager's Team tab holds every territory.
    const service = source("src/lib/phoenix-crm/server/day-start.ts");
    const batch = service.slice(service.indexOf("export async function loadDayStartsBySeat("));
    assert.ok(batch.length > 200, "loadDayStartsBySeat was found");
    assert.ok(batch.includes('.in("seat_id"'), "batched over the seats, never one query per rep");
    assert.ok(batch.includes('.eq("is_test", isTest)'), "and a test entry never leaks into a real reading");

    const team = source("src/lib/phoenix-crm/server/team.ts");
    assert.ok(
      team.includes("loadDayStartsBySeat(seatIds, isTest, viewer.visitDay)"),
      "the Team tab asks for the VISIT day — the same day its own figures are for, not the calendar date",
    );
  }

  console.log("phoenix-crm day start: OK");
}
