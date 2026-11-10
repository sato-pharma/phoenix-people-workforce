import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ACCOUNT_FAR_LINE_METERS,
  FAR_VISIT_HELD_NOTE,
  IMPOSSIBLE_LOCATION_REFUSED,
  READINGS_APART_FLOOR_METERS,
  READINGS_APART_REFUSED,
  RECHECK_LOOKBACK_DAYS,
  RECHECK_MIN_FAR_VISITS,
  RECHECK_MIN_TRIES,
  STUCK_LOOKBACK_DAYS,
  farRefusalLineFor,
  holdInsteadOfRefuse,
  impossibleLocationApplies,
  judgeImpossibleLocation,
  parseFarVisitHoldBasis,
  parseFarVisitHoldStatus,
  readingsApartMeters,
  stuckAtOneSpot,
  visitHeldBeforePlace,
  type FarTry,
  type TimedReading,
} from "../src/lib/phoenix-crm/far-visit-safeguards.ts";
import { distanceMeters } from "../src/lib/phoenix-crm/geo.ts";
import { placesToRecheck, recheckSentence, type RecheckPlace } from "../src/lib/phoenix-crm/places-to-recheck-rules.ts";
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
    assert.match(validate, /if \(validatedAs === "rep"\) place = await guardPlaceReadings\(captured\);/, "🔴 the rep's own validation is judged for an impossible location; a manager's is not");
    assert.match(validate, /else \{\s+await refuseReadingsApart\(captured\);/, "🔴 a manager's capture is still asked whether its two readings can both be the door (2026-11-11)");
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

  // ──────────────────────────────────────────────────────────────────────────────────────────────
  // The validation audit of 11 November 2026 (owner: "Build all six fixes"):
  //   E · a capture whose pin and photo reading cannot both be the door is refused;
  //   F · a visit logged before the customer had a place is held when it is past the line of it;
  //   G · far tries are read a week back, and the places worth a second look are listed for the SFE;
  //   and an approved add validates only a customer who holds a place.
  // ──────────────────────────────────────────────────────────────────────────────────────────────

  // ── E · two readings that cannot both be the door ───────────────────────────────────────────────
  {
    const capture = (photoMetres: number | null, photoAccuracy: number | null = 12, pinAccuracy: number | null = 10) => ({
      ...EL_RAML,
      accuracyMeters: pinAccuracy,
      photoLat: photoMetres === null ? null : north(photoMetres).lat,
      photoLon: photoMetres === null ? null : north(photoMetres).lon,
      photoAccuracyMeters: photoAccuracy,
    });
    assert.equal(READINGS_APART_FLOOR_METERS, 250, "the place's own line");
    const apart = readingsApartMeters(capture(600));
    assert.ok(apart !== null && Math.abs(apart - 600) < 2, "🔴 a pin and a photo reading 600 m apart cannot both be the door");
    assert.equal(readingsApartMeters(capture(200)), null, "200 m apart is inside the line — one door");
    assert.equal(readingsApartMeters(capture(null)), null, "a photo with no reading of its own has nothing to disagree with");
    assert.equal(readingsApartMeters(capture(5000, 300)), null, "a photo reading rougher than the line never fixes the point, so it cannot put it wrong");
    assert.equal(readingsApartMeters(capture(280, 100, 200)), null, "two rough readings are given their own accuracy: 280 m inside 300 m");
    assert.ok(readingsApartMeters(capture(320, 100, 200)) !== null, "and refused past it");
    assert.ok(readingsApartMeters(capture(600, null)) !== null, "a photo reading of unknown accuracy is still compared");
    assert.doesNotMatch(READINGS_APART_REFUSED, /\d|metre|\bkm\b|apart|away|\bfar\b|\bpin\b/i, "the rep reads the way out — never the check or a distance");
    assert.match(READINGS_APART_REFUSED, /take the photo and capture the location again/, "both readings again: either may be the stale one");

    assert.equal(parseRefusedReason("readings_apart"), "readings_apart");
    const rules = read("src/lib/phoenix-crm/refused-readings-rules.ts");
    assert.match(rules, /if \(attempt\.reason === "readings_apart"\) \{/, "the board has a sentence of its own for it");
    assert.match(rules, /so the place was not saved\./, "that says the place was not saved");
  }

  // ── F · a visit logged before the customer had a place ──────────────────────────────────────────
  {
    const visit = { farRuleApplies: true, enteredByRep: true, copiedFromOldSystem: false, archived: false, pastTheLine: true };
    assert.equal(visitHeldBeforePlace(visit), true, "🔴 the rep's own visit, past the line of the place he was then validated at, is held");
    assert.equal(visitHeldBeforePlace({ ...visit, pastTheLine: false }), false, "a visit inside the line counts as it always did");
    assert.equal(visitHeldBeforePlace({ ...visit, farRuleApplies: false }), false, "a visit from before the far rule is never judged by it");
    assert.equal(visitHeldBeforePlace({ ...visit, enteredByRep: false }), false, "a visit a manager entered for him was never refused at the door either");
    assert.equal(visitHeldBeforePlace({ ...visit, copiedFromOldSystem: true }), false, "a copied old visit is never held");
    assert.equal(visitHeldBeforePlace({ ...visit, archived: true }), false, "nor an archived one");
    assert.equal(parseFarVisitHoldBasis("before_place"), "before_place");
    assert.equal(parseFarVisitHoldBasis("stuck"), "stuck");
    assert.equal(parseFarVisitHoldBasis(null), "stuck", "a row written before 2026-11-11 holds the first rule's basis");

    const locations = stripComments(read("src/lib/phoenix-crm/server/visit-locations.ts"));
    const pick = functionBody(locations, /export function visitsToHoldBeforePlace\(/);
    assert.match(pick, /if \(visit\.locationFlag !== "no_place" \|\|/, "🔴 only a visit never measured — a moved place must not un-count work the door once accepted");
    assert.match(pick, /const farMeters = farRefusalLineFor\(input\.listType, input\.visitFarMeters\);/, "the refusal's own line, an account's 500 m included");
    assert.match(pick, /enteredByRep: personKey\(visit\.enteredByHrId\) === personKey\(visit\.repHrId\),/, "the rep's own entry only");
    const restamp = functionBody(locations, /export async function restampVisitLocations\(/);
    const holdAt = restamp.indexOf("await holdVisitsBeforePlace(");
    assert.ok(holdAt > 0 && holdAt < restamp.indexOf("const items = visits.flatMap("), "🔴 the hold is written BEFORE the visits are measured — a re-stamped visit with no hold would start counting");

    const server = stripComments(read("src/lib/phoenix-crm/server/far-visit-safeguards.ts"));
    const hold = functionBody(server, /export async function holdVisitsBeforePlace\(/);
    assert.match(hold, /basis: "before_place",/, "the hold says why it waits");
    assert.match(hold, /tries: 0,/, "nobody was refused: no tries");
    assert.match(hold, /\{ onConflict: "visit_id", ignoreDuplicates: true \}/, "🔴 a visit already held or already decided is never written over");
    assert.match(hold, /throwIfError\(error\);/, "🔴 and a hold that cannot be written stops the re-stamp");
    assert.match(functionBody(server, /async function writeHold\(/), /basis: "stuck",/, "the first rule's holds keep their own basis");

    const page = read("app/(admin)/admin/phoenix-crm/far-visit-holds/page.tsx");
    assert.match(page, /entry\.basis === "before_place"\s+\? "Logged before this customer had a place\./, "the SFE reads why this visit waits");
  }

  // ── G · a week of tries, and the places worth a second look ─────────────────────────────────────
  {
    assert.equal(STUCK_LOOKBACK_DAYS, 7, "the owner's choice: a week, not a day");
    const server = stripComments(read("src/lib/phoenix-crm/server/far-visit-safeguards.ts"));
    assert.match(functionBody(server, /export async function farVisitOutcome\(/), /days: STUCK_LOOKBACK_DAYS,/, "the save reads the week");
    const tries = functionBody(stripComments(read("src/lib/phoenix-crm/server/refused-readings.ts")), /export async function loadRecentFarTries\(/);
    assert.match(tries, /\.gte\("visit_date", addDaysIso\(input\.visitDate, -\(Math\.max\(1, Math\.floor\(input\.days\)\) - 1\)\)\)/, "🔴 the rep who gives up at three and comes back tomorrow is counted");
    assert.match(tries, /\.lte\("visit_date", input\.visitDate\)/);

    assert.equal(RECHECK_MIN_TRIES, 3);
    assert.equal(RECHECK_MIN_FAR_VISITS, 2);
    assert.equal(RECHECK_LOOKBACK_DAYS, 30);
    const place = (id: string, over: Partial<RecheckPlace> = {}): RecheckPlace => ({
      id,
      customerId: `customer-${id}`,
      seatId: "seat",
      ...EL_RAML,
      pinLat: EL_RAML.lat,
      pinLon: EL_RAML.lon,
      pinAccuracyMeters: 10,
      photoLat: null,
      photoLon: null,
      photoAccuracyMeters: null,
      pointSource: "pin",
      movedAt: null,
      trusted: false,
      ...over,
    });
    const photoFar = { photoLat: north(600).lat, photoLon: north(600).lon, photoAccuracyMeters: 10 };
    const refusal = (placeId: string, metres: number, refusedAt = "2026-11-09T10:00:00.000Z") => ({ placeId, ...north(metres), accuracyMeters: 8, refusedAt });
    const list = placesToRecheck({
      places: [
        place("apart", photoFar),
        place("apart-moved", { ...photoFar, movedAt: "2026-11-01T00:00:00.000Z" }),
        place("apart-trusted", { ...photoFar, trusted: true }),
        place("refused"),
        place("refused-twice"),
        place("refused-then-moved", { movedAt: "2026-11-10T00:00:00.000Z" }),
        place("never-inside"),
        place("once-inside"),
        place("quiet"),
      ],
      refusals: [
        refusal("refused", 400), refusal("refused", 405), refusal("refused", 410),
        refusal("refused-twice", 400), refusal("refused-twice", 405),
        refusal("refused-then-moved", 400), refusal("refused-then-moved", 405), refusal("refused-then-moved", 410),
      ],
      visits: [
        { placeId: "never-inside", far: true, capturedAt: "2026-11-08T10:00:00.000Z" },
        { placeId: "never-inside", far: true, capturedAt: "2026-11-09T10:00:00.000Z" },
        { placeId: "once-inside", far: true, capturedAt: "2026-11-08T10:00:00.000Z" },
        { placeId: "once-inside", far: false, capturedAt: "2026-11-09T10:00:00.000Z" },
      ],
    });
    assert.deepEqual(list.map((entry) => entry.placeId), ["refused", "apart", "never-inside"], "🔴 most refused first; a moved or trusted place, two refusals, refusals from before a move and a place once visited inside are not listed");
    const [refused, apart, never] = list;
    assert.equal(refused.findings[0].reason, "refused_one_spot");
    assert.equal(refused.findings[0].count, 3);
    assert.ok(refused.candidate && distanceMeters(refused.candidate, north(405)) < 1, "marker 1 is where the rep stood");
    assert.equal(apart.findings[0].reason, "readings_apart");
    assert.ok(apart.candidate && distanceMeters(apart.candidate, north(600)) < 1, "for a place on its pin, the other candidate is the photo's own reading");
    assert.equal(apart.candidateLabel, "The photo's own reading");
    assert.equal(never.findings[0].reason, "never_inside");
    assert.equal(never.candidate, null, "visits that were never inside point at no one spot");
    assert.equal(recheckSentence({ reason: "readings_apart", metres: 600, count: null }, 30), "The Capture location pin and the photo's own reading are 600 m apart, so one of them is not the door.");
    assert.equal(recheckSentence({ reason: "refused_one_spot", metres: 405, count: 3 }, 30), "Visits were refused 3 times in the last 30 days from one spot, 405 m from the saved place.");
    assert.equal(recheckSentence(never.findings[0], 30), "2 visits in the last 30 days were measured against this place and none was inside its line.");

    const reader = stripComments(read("src/lib/phoenix-crm/server/places-to-recheck.ts"));
    assert.match(functionBody(reader, /export async function loadPlacesToRecheck\(/), /if \(!canDecideFarVisitHolds\(viewer\)\) throw forbiddenError/, "🔴 only the Super Admin and the SFE Manager read the list");
    assert.doesNotMatch(reader, /\.eq\("is_test", true\)/, "real work only");

    // The nightly check reads the page's own list, and all three invariants are registered.
    const checks = read("src/lib/reconciliation/checks/phoenix-crm-places.ts");
    assert.match(read("src/lib/reconciliation/checks/index.ts"), /\.\.\.phoenixCrmPlacesReconciliationChecks,/, "a check that is not in the registry never runs");
    for (const id of ["phoenix-crm-validated-customer-holds-a-place", "phoenix-crm-active-place-holds-a-brick", "phoenix-crm-place-readings-agree"]) {
      assert.ok(checks.includes(`id: "${id}"`), `the nightly check ${id} exists`);
    }
    assert.match(checks, /const \{ list, places \} = await readPlacesToRecheck\(\);/, "the page and the nightly check can never disagree about the list");
    assert.match(
      checks.slice(checks.indexOf('id: "phoenix-crm-validated-customer-holds-a-place"'), checks.indexOf('id: "phoenix-crm-active-place-holds-a-brick"')),
      /expectation: "holds",/,
      "🔴 repaired on 11 November: a validated customer with no place is a breach from now on, never a known finding",
    );
    assert.equal(checks.match(/\.eq\("is_test", false\)/g)?.length, 2, "🔴 test customers were validated with no place by design — they are never counted as a defect");
  }

  // ── The database, 11 November ───────────────────────────────────────────────────────────────────
  {
    const sql = stripSqlComments(read("supabase/migrations/20261111004733_phoenix_crm_validation_gap_fixes.sql")).replace(/\s+/g, " ");
    assert.ok(
      sql.includes("v_has_place := v_customer.list_type not in ('AM', 'PM') or exists ( select 1 from public.phoenix_crm_places pl where pl.customer_id = v_customer.id and pl.status = 'active' );"),
      "🔴 an approved add asks whether the customer holds a place; a pharmacy holds none and keeps the old door",
    );
    const admitted = sql.slice(sql.indexOf("if v_has_place then"), sql.indexOf("'customer_admitted', v_actor"));
    const [withPlace, without] = admitted.split(" else ");
    assert.match(withPlace, /set status = 'active', validated_at = now\(\),/, "with a place he is validated as before");
    assert.match(without, /set status = 'pending', validated_at = null, validated_by_hr_id = null,/, "🔴 ADMITTED IS NOT VALIDATED: with no place he goes to To validate");
    assert.match(without, /reopened_at = now\(\),/, "stamped as a rejected validation is");
    assert.match(without, /grade = coalesce\(v_request\.approved_grade, v_approved_in, v_request\.proposed_grade\), potential_grade = coalesce\(v_request\.potential_grade, v_potential_in\),/, "and keeps the grade he was admitted on");

    assert.ok(
      sql.includes("create constraint trigger phoenix_crm_customers_validated_has_place after update of validated_at on public.phoenix_crm_customers deferrable initially deferred for each row when (old.validated_at is null and new.validated_at is not null and new.list_type in ('AM', 'PM'))"),
      "🔴 no route can make a doctor or an account validated and leave him with no place — asked at commit, and only when the stamp goes from empty to set",
    );
    assert.ok(
      sql.includes("create constraint trigger phoenix_crm_customers_born_validated_has_place after insert on public.phoenix_crm_customers deferrable initially deferred for each row when (new.validated_at is not null and new.list_type in ('AM', 'PM'))"),
      "nor can one be born validated without a place",
    );
    assert.match(sql, /raise exception 'phoenix_crm:validated_without_place';/);
    assert.match(sql, /revoke execute on function public\.phoenix_crm_customers_validated_has_place\(\) from public, anon, authenticated;/, "the guard is no browser role's to call");
    assert.match(sql, /revoke execute on function public\.phoenix_crm_decide_request\(jsonb\) from public, anon, authenticated;/, "and the decision keeps its revoke");
    assert.match(sql, /'impossible_travel'::text, 'readings_apart'::text \]\)\);/, "the eleventh refusal reason");
    assert.match(sql, /add constraint phoenix_crm_far_visit_holds_basis check \(basis in \('stuck', 'before_place'\)\);/, "a hold says why it waits");
    assert.match(sql, /check \( tries between 0 and 1000 and \(basis <> 'stuck' or tries >= 1\) \);/, "a stuck hold still needs its tries; a before-place hold has none");
    assert.doesNotMatch(sql, /\bdelete from public\.|\btruncate\b|\bdrop table\b/, "the migration deletes nothing");
  }

  // ── The doors that RETURN a customer who already holds the stamp (20261111013233) ───────────────
  // The triggers above fire only when the stamp goes from empty to set, so a bring-back and the
  // Administrator's undo of a drop carry the place test themselves.
  {
    const sql = stripSqlComments(read("supabase/migrations/20261111013233_phoenix_crm_bring_back_never_validates_without_place.sql")).replace(/\s+/g, " ");
    const hasPlace =
      "v_has_place := v_customer.list_type not in ('AM', 'PM') or exists ( select 1 from public.phoenix_crm_places pl where pl.customer_id = v_customer.id and pl.status = 'active' );";
    const back =
      "set status = case when c.validated_at is not null and v_has_place then 'active' else 'pending' end, validated_at = case when v_has_place then c.validated_at else null end, validated_by_hr_id = case when v_has_place then c.validated_by_hr_id else null end, reopened_at = case when c.validated_at is not null and not v_has_place then now() else c.reopened_at end,";

    const decide = sql.slice(sql.indexOf("function public.phoenix_crm_decide_request"), sql.indexOf("function public.phoenix_crm_reverse_list_request"));
    const bringBack = decide.slice(decide.indexOf("elsif v_request.kind = 'restore' then"), decide.indexOf("'customer_restored', v_actor"));
    assert.ok(bringBack.includes(`${hasPlace} update public.phoenix_crm_customers c ${back}`), "🔴 a bring-back puts a validated customer on the list only while he holds a place");
    assert.match(decide, /set status = 'pending', validated_at = null, validated_by_hr_id = null,/, "the add branch is carried over whole from 20261111004733");

    const reverse = sql.slice(sql.indexOf("function public.phoenix_crm_reverse_list_request"));
    const undoneAdd = reverse.slice(reverse.indexOf("elsif v_request.kind = 'add' then"), reverse.indexOf("'add_reversed'"));
    assert.match(undoneAdd, /if v_customer\.status not in \('active', 'pending'\) then raise exception 'phoenix_crm:reverse_customer_moved_on';/, "🔴 an add that admitted to To validate can still be undone");
    assert.match(undoneAdd, /set status = 'dropped', dropped_reason = 'not_admitted',/, "and leaves as a refused add does");
    const undoneDrop = reverse.slice(reverse.indexOf("elsif v_request.kind = 'drop' then"), reverse.indexOf("'drop_reversed'"));
    assert.ok(undoneDrop.includes(`${hasPlace} update public.phoenix_crm_customers c ${back}`), "🔴 an undone drop returns a validated customer to the list only while he holds a place");
    assert.match(reverse, /and ev\.created_at > v_request\.decided_at/, "anything that moved the customer since the decision is still refused first");

    for (const fn of ["phoenix_crm_decide_request", "phoenix_crm_reverse_list_request"]) {
      assert.ok(sql.includes(`revoke execute on function public.${fn}(jsonb) from public, anon, authenticated; grant execute on function public.${fn}(jsonb) to service_role;`), `${fn} keeps its revoke`);
    }
    assert.doesNotMatch(sql, /\bdelete from public\.|\btruncate\b|\bdrop table\b|\balter table\b/, "two functions, no table and no row");
    assert.match(read("src/lib/phoenix-crm/server/db.ts"), /validated_without_place: \{ status: 409, message: "This customer has no saved place, so it cannot be validated\. Capture the place first\." \}/, "the guard has its own sentence");
  }

  console.log("phoenix-crm-far-visit-safeguards: PASS");
}
