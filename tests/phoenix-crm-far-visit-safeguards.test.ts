import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ACCOUNT_FAR_LINE_METERS,
  FAR_VISIT_HELD_NOTE,
  IMPOSSIBLE_LOCATION_REFUSED,
  farRefusalLineFor,
  holdInsteadOfRefuse,
  impossibleLocationApplies,
  judgeImpossibleLocation,
  parseFarVisitHoldStatus,
  stuckAtOneSpot,
  type FarTry,
  type TimedReading,
} from "../src/lib/phoenix-crm/far-visit-safeguards.ts";
import { distanceMeters } from "../src/lib/phoenix-crm/geo.ts";
import { parseRefusedReason, refusalSentence } from "../src/lib/phoenix-crm/refused-readings-rules.ts";
import { kpiHoldBackOf, visitCountsInKpi } from "../src/lib/phoenix-crm/unplanned-rules.ts";
import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The four safeguards around a customer's place (owner, 2026-11-10: "how to avoid these issues so they
// never happen again?" — he chose all four), after Momen Fathy validated Dr. Doria Darraz on a stairwell:
// his phone placed him by Wi-Fi in Moharam Bek, 8.3 km from the clinic in El Raml, five minutes after his
// own visit had saved in El Raml, and every visit to her was refused at her door — 51 times.
//
//   A · a place reading the rep could not have reached from his own last saved visit is refused, and the
//       same point is refused again, exactly, for six hours;
//   B · five far refusals from one tight spot on one customer in one day tell the Super Admin and the SFE
//       Manager, once, never by email;
//   C · the next visit from that spot is saved and HELD for the SFE, counting in nothing until approved;
//   D · an account (AM) is refused only past 500 m; a clinic keeps the settings' 300 m.
// ─────────────────────────────────────────────────────────────────────────────

/** Momen's own 13:06 reading at Al Hilal Hospital, El Raml — where Dr. Doria Darraz's place now sits. */
const EL_RAML = { lat: 31.2317209, lon: 29.9713254 };
/** A point about 8 km south-west of it: where an indoor Wi-Fi guess put him. */
const MOHARAM_BEK = { lat: 31.185, lon: 29.905 };
const NOW = new Date("2026-11-10T11:12:00.000Z");

function minutesBefore(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

function anchor(minutes: number, accuracyMeters: number | null = 12, at = EL_RAML): TimedReading {
  return { ...at, accuracyMeters, at: minutesBefore(minutes) };
}

/** A point `metres` due north of EL_RAML. */
function north(metres: number): { lat: number; lon: number } {
  return { lat: EL_RAML.lat + metres / 111_320, lon: EL_RAML.lon };
}

function read(file: string): string {
  return readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

/** The body of one exported function, from its signature to the closing brace at column zero. */
function functionBody(source: string, signature: RegExp): string {
  const start = source.search(signature);
  assert.ok(start >= 0, `the function ${signature} is still in the file`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, `the function ${signature} still closes at column zero`);
  return source.slice(start, end);
}

export function runPhoenixCrmFarVisitSafeguardsTests() {
  // ── A · an impossible location ─────────────────────────────────────────────────────────────────
  {
    const metres = distanceMeters(EL_RAML, MOHARAM_BEK);
    assert.ok(metres > 8000 && metres < 9000, `the fixture is Momen's distance (${Math.round(metres)} m)`);

    const momen = judgeImpossibleLocation({ reading: MOHARAM_BEK, now: NOW, anchors: [anchor(5.3)], refusedPoints: [] });
    assert.equal(momen.impossible, true, "🔴 Momen's validation: 8 km in 5.3 minutes from his own saved visit is refused");
    assert.equal(momen.impossible && momen.why, "travel");

    const later = judgeImpossibleLocation({ reading: MOHARAM_BEK, now: NOW, anchors: [anchor(8)], refusedPoints: [] });
    assert.equal(later.impossible, false, "the same 8 km after eight minutes is reachable — the bar is 80 km/h, not a wall");
    const repeat = judgeImpossibleLocation({ reading: MOHARAM_BEK, now: NOW, anchors: [anchor(8)], refusedPoints: [MOHARAM_BEK] });
    assert.equal(repeat.impossible && repeat.why, "repeat", "🔴 but the exact point already refused as impossible is refused again: a Wi-Fi guess repeats itself");
    const nearlySame = judgeImpossibleLocation({
      reading: { lat: MOHARAM_BEK.lat + 0.0000001, lon: MOHARAM_BEK.lon },
      now: NOW,
      anchors: [],
      refusedPoints: [MOHARAM_BEK],
    });
    assert.equal(nearlySame.impossible, false, "the repeat is compared exactly: a real reading moves");
    const repeatWithoutAnchor = judgeImpossibleLocation({ reading: MOHARAM_BEK, now: NOW, anchors: [], refusedPoints: [MOHARAM_BEK] });
    assert.equal(repeatWithoutAnchor.impossible && repeatWithoutAnchor.why, "repeat", "a repeat needs no anchor");

    const close = judgeImpossibleLocation({ reading: north(2500), now: NOW, anchors: [anchor(0.5)], refusedPoints: [] });
    assert.equal(close.impossible, false, "under 3 km nothing is impossible, however fast");
    const rough = judgeImpossibleLocation({ reading: MOHARAM_BEK, now: NOW, anchors: [anchor(5.3, 60)], refusedPoints: [] });
    assert.equal(rough.impossible, false, "a rough visit (over 50 m) is no proof of where he stood");
    const unknownAccuracy = judgeImpossibleLocation({ reading: MOHARAM_BEK, now: NOW, anchors: [anchor(5.3, null)], refusedPoints: [] });
    assert.equal(unknownAccuracy.impossible, false, "nor is a visit whose accuracy is unknown");
    const old = judgeImpossibleLocation({ reading: MOHARAM_BEK, now: NOW, anchors: [anchor(61)], refusedPoints: [] });
    assert.equal(old.impossible, false, "a visit older than an hour says nothing about where he is now");
    const future = judgeImpossibleLocation({ reading: MOHARAM_BEK, now: NOW, anchors: [anchor(-2)], refusedPoints: [] });
    assert.equal(future.impossible, false, "a visit stamped after now is never an anchor");
    const latestWins = judgeImpossibleLocation({ reading: MOHARAM_BEK, now: NOW, anchors: [anchor(5), anchor(2, 12, MOHARAM_BEK)], refusedPoints: [] });
    assert.equal(latestWins.impossible, false, "the LATEST saved visit is the anchor: he really was at Moharam Bek two minutes ago");
    const noFix = judgeImpossibleLocation({ reading: { lat: 0, lon: 0 }, now: NOW, anchors: [anchor(1)], refusedPoints: [{ lat: 0, lon: 0 }] });
    assert.equal(noFix.impossible, false, "an unusable reading is left to the rules that already refuse it");

    assert.equal(impossibleLocationApplies("2026-11-09"), false, "never reaches back: a place validated before 10 November is not re-judged");
    assert.equal(impossibleLocationApplies("2026-11-10"), true);
    assert.equal(impossibleLocationApplies("garbage"), false);

    // Golden Rule #1: the rep reads his own way out, never the check, a distance or a speed.
    assert.doesNotMatch(IMPOSSIBLE_LOCATION_REFUSED, /\d|km|speed|fast|impossible|visit/i, "the rep is never told what was measured");
    assert.match(IMPOSSIBLE_LOCATION_REFUSED, /Step outside/, "only how to get a reading that settles");

    // The SFE's board reads the new reason as itself, with the metres from his own visit.
    assert.equal(parseRefusedReason("impossible_travel"), "impossible_travel");
    const sentence = refusalSentence({
      subjectKind: "place",
      reason: "impossible_travel",
      accuracyMeters: 46,
      photoAccuracyMeters: null,
      maxAccuracyMeters: null,
      blockedPermission: null,
      distanceMeters: 8300,
    });
    assert.match(sentence, /8\.3 km/, `the SFE reads the distance from the rep's own visit (${sentence})`);
    assert.doesNotMatch(sentence, /too rough/, "and never the rough-reading sentence");
  }

  // ── B and C · a rep stuck at one spot ───────────────────────────────────────────────────────────
  {
    const at = (metres: number, accuracyMeters: number | null = 8): FarTry => ({ ...north(metres), accuracyMeters });
    const four = [at(0), at(5), at(10), at(15)];
    assert.equal(stuckAtOneSpot(four).stuck, false, "four refusals are not yet stuck");
    const five = [...four, at(20)];
    const verdict = stuckAtOneSpot(five);
    assert.equal(verdict.stuck, true, "five refusals from one spot are");
    assert.equal(verdict.tries, 5);
    assert.ok(verdict.centre && distanceMeters(verdict.centre, north(10)) < 1, "the spot's centre is the middle of the tries — where the place should probably be");
    assert.equal(stuckAtOneSpot([...four, at(20, 40)]).stuck, false, "a rough try (over 30 m) is no proof of where he stood");
    assert.equal(stuckAtOneSpot([...four, at(20, null)]).stuck, false, "nor a try of unknown accuracy");
    assert.equal(stuckAtOneSpot([at(0), at(30), at(60), at(90), at(120)]).stuck, false, "five tries spread over 120 m are a rep walking about, not one spot");

    const hold = holdInsteadOfRefuse(five, at(12));
    assert.equal(hold.hold, true, "🔴 the next visit from the same spot is SAVED and held, not refused");
    assert.equal(holdInsteadOfRefuse(five, at(250)).hold, false, "a rep who walks off somewhere else is refused as before");
    assert.equal(holdInsteadOfRefuse(five, at(12, 45)).hold, false, "and so is a rough reading at the spot");
    assert.equal(holdInsteadOfRefuse(four, at(12)).hold, false, "the hold needs five refusals BEFORE it");

    assert.doesNotMatch(FAR_VISIT_HELD_NOTE, /\d|metre|km|away|far|place/i, "the rep reads that it is saved and when it counts — never why");
    assert.match(FAR_VISIT_HELD_NOTE, /counts once SFE approves it/);
    assert.equal(parseFarVisitHoldStatus("sfe_pending"), "sfe_pending");
    assert.equal(parseFarVisitHoldStatus("pending"), null);

    // A held visit counts in nothing until the SFE approves it — the countable views' own clause.
    const base = { isUnplanned: false, unplannedKind: null, unplannedStatus: null, customerValidated: true } as const;
    assert.equal(visitCountsInKpi({ ...base, farHoldStatus: "sfe_pending" }), false, "a held visit waiting for the SFE counts in nothing");
    assert.equal(visitCountsInKpi({ ...base, farHoldStatus: "refused" }), false, "a refused one never counts");
    assert.equal(visitCountsInKpi({ ...base, farHoldStatus: "approved" }), true, "an approved one counts like any visit");
    assert.equal(visitCountsInKpi({ ...base, farHoldStatus: null }), true, "no hold, nothing changes");
    assert.equal(kpiHoldBackOf({ ...base, farHoldStatus: "sfe_pending" }), "approval");
  }

  // ── D · the line of an account ──────────────────────────────────────────────────────────────────
  {
    assert.equal(ACCOUNT_FAR_LINE_METERS, 500, "the owner's number: 500 m");
    assert.equal(farRefusalLineFor("AM", 300), 500, "🔴 a hospital or account is refused only past 500 m");
    assert.equal(farRefusalLineFor("PM", 300), 300, "a doctor's clinic keeps the settings' 300 m");
    assert.equal(farRefusalLineFor("Pharmacy", 300), 300, "a pharmacy keeps it too");
    assert.equal(farRefusalLineFor("AM", 800), 800, "a wider setting is never narrowed");
    assert.equal(farRefusalLineFor("PM", Number.NaN), 300, "an unreadable setting falls back to 300 m");
  }

  // ── The wiring ──────────────────────────────────────────────────────────────────────────────────
  {
    const server = stripComments(read("src/lib/phoenix-crm/server/far-visit-safeguards.ts"));
    const outcome = functionBody(server, /export async function farVisitOutcome\(/);
    const writeAt = outcome.indexOf("await writeHold(");
    const refuseAt = outcome.indexOf("await recordFarVisitRefusal(");
    assert.ok(writeAt > 0 && refuseAt > writeAt, "the hold is tried first, and a hold that cannot be written refuses as before");
    assert.match(outcome, /if \(held\) return \{ hold: true, tries: verdict\.tries \};/, "🔴 only a WRITTEN hold lets the visit save — a visit saved without its hold would count");
    assert.match(outcome, /if \(!before\.stuck && after\.stuck && !input\.isTest\) \{/, "the alert fires once, on the try that crosses into stuck, never for a test row");

    const notify = functionBody(server, /async function notifyStuckRep\(/);
    assert.match(notify, /channels: phoenixCrmChannels\("far_visit_stuck"\)/, "🔴 the module's channel guard decides the channels — it bars email for all of Phoenix CRM");
    assert.match(notify, /resolveHrIdsForRole\("Super Admin"/, "the Super Admin is told");
    assert.match(notify, /sfeManagerHrIds\(\)/, "and the SFE Managers");
    assert.match(notify, /idempotencyKey: `phoenix_crm:far_visit_stuck:\$\{personKey\(input\.repHrId\)\}:\$\{input\.customerId\}:\$\{input\.visitDate\}`/, "once per rep, customer and day");

    const decide = functionBody(server, /export async function decideFarVisitHold\(/);
    assert.match(decide, /if \(!canDecideFarVisitHolds\(viewer\)\) throw forbiddenError/, "only the Super Admin and the SFE Manager decide");
    assert.match(decide, /\.eq\("status", "sfe_pending"\)/, "and only a hold still waiting moves");

    const visits = stripComments(read("src/lib/phoenix-crm/server/visits.ts"));
    const saveVisit = functionBody(visits, /export async function saveVisit\(/);
    const outcomeAt = saveVisit.indexOf("await farVisitOutcome(");
    assert.ok(outcomeAt > 0, "saveVisit asks farVisitOutcome");
    assert.ok(saveVisit.indexOf("claimRequiredRecording(") > outcomeAt, "before a required recording is claimed");
    assert.ok(saveVisit.indexOf('"phoenix_crm_save_visit"') > outcomeAt, "🔴 and the hold row is written BEFORE the visit — it is never counted for an instant");
    assert.match(saveVisit, /farHoldNote: heldForSfe \? FAR_VISIT_HELD_NOTE : null,/, "the rep reads that his held visit is saved");
    assert.match(saveVisit, /if \(heldForSfe\) await stampFarVisitHoldDay\(visitId, String\(result\.visit_date\)\);/, "and the hold carries the visit's own day");

    const day = functionBody(visits, /export async function loadVisitDay\(/);
    assert.match(day, /farHolds\.has\(mapped\.visitId\) \? \{ \.\.\.mapped, countsInKpi: false \} : mapped/, "the visit list says a held visit counts in nothing, as the views do");

    const list = stripComments(read("src/lib/phoenix-crm/server/list.ts"));
    const validate = functionBody(list, /export async function validateCustomer\(/);
    assert.match(validate, /validatedAs === "rep"\s+\? await guardPlaceReadings\(\{/, "🔴 the rep's own validation is judged for an impossible location; a manager's keeps today's door");
    const addPlace = functionBody(list, /export async function addPlace\(/);
    assert.match(addPlace, /place = await guardPlaceReadings\(\{/, "and a second clinic is judged as the first");

    const tab = read("src/components/phoenix-crm/visits-tab.tsx");
    assert.match(tab, /\{visit\.farHoldNote \? <span className="mt-1 block">\{visit\.farHoldNote\}<\/span> : null\}/, "the rep's save screen shows the held note");

    const route = read("app/api/phoenix-crm/far-visit-holds/decide/route.ts");
    assert.ok(route.indexOf("assertSameOriginMutation(request)") < route.indexOf("decideFarVisitHold("), "the decide route checks the origin first");
    assert.match(route, /await assertPermission\(access, "phoenix_crm", "approve"\);/, "and asks approve before the service");

    const page = read("app/(admin)/admin/phoenix-crm/far-visit-holds/page.tsx");
    const gate = page.indexOf('canAccess(access, "phoenix_crm", "read")');
    assert.ok(gate > 0 && gate < page.indexOf("resolvePhoenixCrmViewer("), "the page asks gate one before the organogram");
    assert.match(page, /!canDecideFarVisitHolds\(viewer\)\) redirect\("\/admin"\)/, "and lets only the two deciders in");
  }

  // ── The database ────────────────────────────────────────────────────────────────────────────────
  {
    const sql = stripSqlComments(read("supabase/migrations/20261110170000_phoenix_crm_far_visit_safeguards.sql")).replace(/\s+/g, " ");
    const held = "and v.id not in ( select h.visit_id from public.phoenix_crm_far_visit_holds h where h.status <> 'approved' )";
    const countable = sql.slice(sql.indexOf("create or replace view public.phoenix_crm_countable_visits with"), sql.indexOf("revoke all on table public.phoenix_crm_countable_visits from"));
    const history = sql.slice(sql.indexOf("create or replace view public.phoenix_crm_countable_visits_with_history"), sql.indexOf("revoke all on table public.phoenix_crm_countable_visits_with_history"));
    assert.ok(countable.includes(held), "🔴 the countable view leaves a held visit out until the SFE approves it");
    assert.ok(history.includes(held), "🔴 and so does the history view");
    assert.ok(countable.includes("with (security_invoker = true)") && history.includes("with (security_invoker = true)"), "both keep security_invoker");
    assert.match(sql, /visit_id uuid primary key/, "one hold per visit — and the primary key keeps NULL out of the NOT IN");
    assert.match(sql, /alter table public\.phoenix_crm_far_visit_holds enable row level security;/, "the hold table has RLS on");
    assert.match(sql, /revoke all on table public\.phoenix_crm_far_visit_holds from public, anon, authenticated;/, "and no browser role may read it");
    assert.match(sql, /'far_from_place'::text, 'impossible_travel'::text/, "the tenth refusal reason");
    assert.doesNotMatch(sql, /\b(delete from|update) public\./, "the migration writes no row and deletes none");
  }

  console.log("phoenix-crm-far-visit-safeguards: PASS");
}
