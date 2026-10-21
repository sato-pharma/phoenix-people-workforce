import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

import { cairoBusinessDay, VISIT_DAY_CUTOFF_HOURS } from "../src/lib/phoenix-crm/calendar.ts";
import { NO_FIX_FOR_A_VISIT, parseVisitDraft } from "../src/lib/phoenix-crm/entry-rules.ts";

/**
 * Phoenix CRM — the one-tap visit (owner, 2026-09-29).
 *
 * "The medical rep just presses; in the back end we take his location." Log visit is ONE tap: no
 * photo, no date, no AM/PM picker. The server stamps the time, AM or PM comes from the customer, and
 * the location is read in silence from the moment the form opens.
 *
 * Three things are pinned here, each of which goes wrong QUIETLY:
 *
 *   (a) THE VISIT DAY ENDS AT 02:00. "The visits of today are entered today, maximum 2 AM." The day a
 *       visit is filed under is the Cairo date of (the time − 2 hours) — the same arithmetic as
 *       `phoenix_crm_save_visit`, so the page and the database never disagree. Egypt's clock changes
 *       twice a year and the subtraction is on the absolute instant, so the change nights are pinned
 *       with explicit UTC instants.
 *   (b) THE DRAFT NEEDS NO PHOTO AND NO PHARMACY, but it does need a location — and the refusal when
 *       there is none is about HIS OWN work (switch location on), never about a check.
 *   (c) THE REP'S SCREENS SAY NOTHING ABOUT WHERE HE STOOD. Golden Rule #1, the BLIND half: no
 *       distance, no accuracy, no "Take care", no location sentence — on the visit form, the day list
 *       or Today.
 */

const ROOT = new URL("../", import.meta.url);

function source(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8"));
}

/** A visit body with a live fix over Cairo and nothing optional. */
function visitBody(patch: Record<string, unknown>): Record<string, unknown> {
  return {
    customerId: "11111111-1111-4111-8111-111111111111",
    kind: "single",
    products: ["Satoprazole"],
    comment: "Discussed the new dose.",
    lat: 30.05,
    lon: 31.23,
    accuracyMeters: 12,
    deviceCapturedAt: "2026-09-29T09:00:00.000Z",
    ...patch,
  };
}

function day(isoInstant: string): string {
  return cairoBusinessDay(new Date(isoInstant));
}

export function runPhoenixCrmOneTapVisitTests(): void {
  // ── (a) The visit day ends at 02:00 ────────────────────────────────────────────────────────────
  {
    assert.equal(VISIT_DAY_CUTOFF_HOURS, 2, "the owner's cutoff is 02:00");

    // Egypt keeps summer time (UTC+3) from the last Friday of April to the last Thursday of October
    // (Law 24 of 2023). Every expectation below leans on the runtime knowing that, so it is asserted
    // first: a runtime whose time-zone data predates 2023 would fail here, by name, rather than below.
    const cairoHour = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: "Africa/Cairo" });
    assert.equal(cairoHour.format(new Date("2026-07-01T12:00:00Z")), "15", "this runtime must know Egypt's summer time (UTC+3)");
    assert.equal(cairoHour.format(new Date("2026-12-01T12:00:00Z")), "14", "and its winter time (UTC+2)");

    // 30 September 2026, summer time: Cairo = UTC+3.
    assert.equal(day("2026-09-29T21:03:00Z"), "2026-09-29", "00:03 on the 30th is still the 29th's visit day");
    assert.equal(day("2026-09-29T22:59:00Z"), "2026-09-29", "01:59 is still the day before");
    assert.equal(day("2026-09-29T23:00:00Z"), "2026-09-30", "02:00 is the new day");
    assert.equal(day("2026-09-30T09:00:00Z"), "2026-09-30", "the middle of the day is that day");
    assert.equal(day("2026-09-30T20:59:00Z"), "2026-09-30", "23:59 is that day");

    // The night the clocks go BACK: Thursday 29 October 2026. At 24:00 summer time (21:00 UTC) the
    // clock returns to 23:00, so Thursday's last hour happens twice — and both passes are Thursday's.
    // Friday's 02:00 is then 00:00 UTC, and the cutoff stays at 02:00 on the wall.
    assert.equal(day("2026-10-28T22:59:00Z"), "2026-10-28", "Thursday 01:59, still summer time: Wednesday's visit day");
    assert.equal(day("2026-10-28T23:00:00Z"), "2026-10-29", "Thursday 02:00, still summer time: Thursday's");
    assert.equal(day("2026-10-29T20:30:00Z"), "2026-10-29", "Thursday 23:30, the first pass of the repeated hour");
    assert.equal(day("2026-10-29T21:30:00Z"), "2026-10-29", "Thursday 23:30 again, after the clocks went back");
    assert.equal(day("2026-10-29T23:59:00Z"), "2026-10-29", "Friday 01:59, winter time: still Thursday's visit day");
    assert.equal(day("2026-10-30T00:00:00Z"), "2026-10-30", "Friday 02:00, winter time: Friday's");

    // The night the clocks go FORWARD: Friday 24 April 2026, 00:00 winter time (22:00 UTC) becomes
    // 01:00. Two hours back from the wall's 02:00 lands before the jump, on Thursday — so on this one
    // night the day turns at 03:00 on the wall. That is the database's own arithmetic too
    // (`captured_at - interval '2 hours'` on the instant), which is the point: both sides agree.
    assert.equal(day("2026-04-23T23:00:00Z"), "2026-04-23", "Friday 02:00 on the jump night is still Thursday's");
    assert.equal(day("2026-04-23T23:59:00Z"), "2026-04-23", "Friday 02:59 on the jump night is still Thursday's");
    assert.equal(day("2026-04-24T00:00:00Z"), "2026-04-24", "Friday 03:00 on the jump night is Friday's");

    // And the database files a visit by the same arithmetic, so the page and the save never disagree.
    const sql = stripSqlComments(readFileSync(new URL("supabase/migrations/20260929235553_phoenix_crm_one_tap_visit.sql", ROOT), "utf8"));
    assert.ok(
      sql.includes("v_date := ((v_captured_at - interval '2 hours') at time zone 'Africa/Cairo')::date;"),
      "phoenix_crm_save_visit files the visit under the Cairo date of (the time − 2 hours)",
    );
  }

  // ── (b) The draft: no photo, no pharmacy, and a plain sentence when there is no location ────────
  {
    const bare = parseVisitDraft(visitBody({}));
    assert.equal(bare.ok, true, "a visit with no photo and no pharmacy is a whole visit");
    if (bare.ok) {
      assert.equal(bare.value.photoPath, null, "no photo slot");
      assert.equal(bare.value.pharmacyName, null, "the pharmacy is optional");
      assert.equal(bare.value.visitType, "planned", "a visit that says nothing is planned");
    }

    const legacy = parseVisitDraft(visitBody({ visitType: "unplanned", unplannedReason: "The customer called me in about stock." }));
    assert.equal(legacy.ok, true);
    if (legacy.ok) assert.equal(legacy.value.visitType, "out_of_plan", "a caller one release behind saying \"unplanned\" means out of plan");

    const noReason = parseVisitDraft(visitBody({ visitType: "out_of_plan" }));
    assert.equal(noReason.ok, false, "out of plan still needs his reason");

    const outOfList = parseVisitDraft(visitBody({ visitType: "out_of_list" }));
    assert.equal(outOfList.ok, true, "out of list needs no reason — it waits on the customer being added, not on an approval");
    if (outOfList.ok) {
      assert.equal(outOfList.value.visitType, "out_of_list");
      assert.equal(outOfList.value.unplannedReason, null);
    }

    assert.equal(NO_FIX_FOR_A_VISIT, "Turn on location for your browser, then tap Log visit again.", "about his own work, never a check — and the browser he is in, never \"Phoenix\"");
    const noFix = parseVisitDraft(visitBody({ lat: undefined, lon: undefined }));
    assert.equal(noFix.ok, false, "a visit with no location is not saved");
    if (!noFix.ok) assert.equal(noFix.error, NO_FIX_FOR_A_VISIT);
  }

  // ── (c) The rep's screens ───────────────────────────────────────────────────────────────────────
  {
    const form = source("src/components/phoenix-crm/visit-log-form.tsx");
    // No date: the server stamps the time and files the day.
    assert.equal(/type="date"/.test(form), false, "the visit form has no date input");
    assert.equal(/\bvisitDate\b|\bcapturedAt:/.test(form), false, "and sends no day or time of its own");
    // No photo: a visit is taps.
    for (const photo of [/LivePhotoCapture/, /\bphotoPath\b/, /CapturedPhoto/, /reusePlacePhoto/]) {
      assert.equal(photo.test(form), false, `the visit form takes no photo (${photo})`);
    }
    // No AM/PM choice: AM or PM comes from the customer.
    assert.equal(/value: "AM"|value: "PM"|setListType/.test(form), false, "the visit form offers no AM/PM choice");
    // One button.
    assert.match(
      form,
      /onClick=\{\(\) => void save\(Date\.now\(\)\)\} variant="primary">\s*\{saving \? "Saving…" : "Log visit"\}/,
      "the one button is Log visit — one tap, saying only \"Saving…\" while it works",
    );
    // The location, read in silence and sent with the save — never shown.
    assert.ok(form.includes("const readFix = useSilentFix();"), "the form reads the location through the silent reader");
    assert.ok(form.includes("...silentFixPayload(fix, savedAt)"), "and sends it with the save");
    assert.ok(form.includes("setProblem(NO_FIX_FOR_A_VISIT);"), "with no location it says the server's own sentence, nothing more");

    // 🔴 GOLDEN RULE #1, the BLIND half. Case-insensitive, comments stripped: the prose explaining the
    // absence necessarily names it.
    for (const path of [
      "src/components/phoenix-crm/visits-tab.tsx",
      "src/components/phoenix-crm/visit-log-form.tsx",
    ]) {
      const code = source(path);
      for (const word of [/take care/i, /locationLabel/i, /distance/i, /accuracy/i]) {
        assert.equal(word.test(code), false, `${path} must not carry ${word} onto the rep's screen`);
      }
    }

    // The silent reader: high accuracy, watched from the moment the form opens and stopped when it
    // goes, and "not asked" on the web — never "clean".
    const fix = source("src/components/phoenix-crm/use-silent-fix.ts");
    assert.ok(fix.includes("navigator.geolocation.watchPosition("), "the position is watched, not read once at the tap");
    assert.ok(fix.includes("enableHighAccuracy: true"), "at high accuracy");
    assert.match(fix, /useEffect\(\(\) => \{\s*start\(\);\s*return \(\) => stop\(\);\s*\}, \[start, stop\]\);/, "from mount to unmount");
    assert.ok(fix.includes("export const SILENT_FIX_WAIT_MS = 8_000;"), "Log visit waits up to 8 seconds for a first reading");
    assert.ok(fix.includes("deviceMocked: null,"), "a browser cannot ask whether a reading is real, so it says nothing");

    // Out of list: validated on the spot through the List's own route and the List's own place body,
    // so the photo's own reading travels under the keys the server's parser reads (`shutter*`,
    // entry-rules.ts parseCapturedFix) — never filled in from the pin.
    const outside = source("src/components/phoenix-crm/out-of-list-entry.tsx");
    assert.ok(outside.includes('mode: "outside"'), "an out-of-list customer is validated as an outside customer");
    assert.ok(outside.includes('"/api/phoenix-crm/list/validate"'), "through the List's own validate");
    assert.ok(outside.includes("place: placePayload(photo, draft),"), "with the List's own place body — one builder, not two");
    const editor = source("src/components/phoenix-crm/place-editor.tsx");
    const payload = /export function placePayload\([\s\S]*?\n\}/.exec(editor)?.[0] ?? "";
    assert.notEqual(payload, "", "place-editor.tsx still builds the place body in one function");
    for (const key of ["shutterLat: photo.shutterLat,", "shutterLon: photo.shutterLon,", "shutterAccuracyMeters: photo.shutterAccuracyMeters,", "shutterCapturedAt: photo.shutterCapturedAt,"]) {
      assert.ok(payload.includes(key), `the photo's own reading is sent under the server's key (${key})`);
    }
    assert.equal(/(shutter|photo)(Lat|Lon): photo\.(lat|lon)\b/.test(payload), false, "the photo's reading is never the pin's");
    assert.ok(outside.includes('code === "phoenix_crm_same_name"') && outside.includes("void save(true)"), "the same name asks, then resends as a different person");
    assert.ok(outside.includes('listText("AM")') && outside.includes('listText("PM")'), "AM or PM is chosen BY HAND for someone new");

    // Planned offers only today's sent plan; out of plan is the rest of his list, without the
    // customers waiting outside it — and without his pharmacies, which have a door of their own
    // (Pharmacy visit, owner 2026-10-03) and are never out of plan.
    const picker = source("src/components/phoenix-crm/visit-customer-picker.tsx");
    assert.ok(picker.includes("if (customer.outside) return false;"), "a customer waiting outside the list is offered by neither");
    assert.ok(
      picker.includes('return mode === "planned" ? customer.plannedToday : !customer.plannedToday;'),
      "planned = today's sent plan; out of plan = the list minus today's plan",
    );

    // The nine first choices, and ONE write of the day's activity.
    const start = source("src/components/phoenix-crm/visit-start.tsx");
    assert.ok(start.includes('label="Planned visit"') && start.includes('label="Unplanned visit"'), "Planned and Unplanned lead");
    assert.ok(start.includes("PHOENIX_CRM_DAY_ACTIVITIES.map"), "then the nine day activities");
    assert.ok(start.includes('crmPost<DayActivitySaved>("/api/phoenix-crm/day-activities"'), "saved through the existing day-activity route");
    const tab = source("src/components/phoenix-crm/visits-tab.tsx");
    assert.ok(tab.includes("saveDayActivity(view.territory.seatId, view.isTest, choice)"), "the day list's own block writes through the same one save");
    assert.equal(/crmPost[^(]*\("\/api\/phoenix-crm\/day-activities"/.test(tab), false, "and has no second write of its own");

    // Found on the walk of 2026-09-30. The portal's "+ Add visit" opens the first screen before the
    // day has answered: it must say it is still opening, never tell the rep his own day is someone
    // else's to record.
    assert.ok(
      tab.includes("canSetDayActivity={date !== null ? false : view ? view.canSetDayActivity || view.canSetOwnDayActivity : null}"),
      "a day still loading reaches the first screen as null, not as a refusal",
    );
    assert.ok(start.includes("canSetDayActivity === false ?"), "only a real refusal says the day is the territory rep's");
    assert.ok(start.includes("disabled={canSetDayActivity !== true}"), "the activity tiles wait for the answer");
    // And at 01:54 the header read the CALENDAR day while the day loaded. The page hands the visit day.
    const app = source("src/components/phoenix-crm/phoenix-crm-app.tsx");
    assert.ok(app.includes("openingDay={overview.visitDay}"), "the Visits tab opens on the visit day, never the calendar date");
    assert.equal(/\bcairoToday\b/.test(tab), false, "the Visits tab reads no calendar date at all");
    assert.ok(source("src/lib/phoenix-crm/server/overview.ts").includes("visitDay: viewer.visitDay"), "the overview carries the server's visit day");

    // The comment is required (owner, 2026-09-30) — typed or spoken, checked on the phone and again
    // by parseVisitDraft on the server.
    const logForm = source("src/components/phoenix-crm/visit-log-form.tsx");
    assert.ok(logForm.includes("if (!comment.trim()) return { ok: false, problem: VISIT_COMMENT_REQUIRED };"), "the form stops an empty comment before the save");
    assert.ok(logForm.includes("hint={`Required — type it or speak it"), "and says it is required");
    assert.equal(logForm.includes("hint={`Optional · ${commentLength}"), false, "it is no longer optional");
    assert.equal(parseVisitDraft(visitBody({ comment: "  " })).ok, false, "the server refuses a blank comment too");
  }

  console.log("phoenix-crm one-tap visit: OK");
}
