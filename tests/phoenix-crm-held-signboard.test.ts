import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  heldSignboardCheckToKeep,
  heldSignboardOutcome,
  heldSignboardReaderIsDown,
  heldSignboardReadHappened,
  judgeSignboards,
  SIGNBOARD_HELD_MAX_READS,
  signboardDoorHolds,
  signboardHoldStillReading,
  signboardReadsCustomerName,
  signboardReadsRecorded,
  signboardUnjudged,
  type PhoenixCrmSign,
  type PhoenixCrmSignboardCheck,
  type SignboardCheckReason,
} from "../src/lib/phoenix-crm/signboard-rules.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — a signboard the door could not confirm is HELD, re-read by the system, approved by the
 * system once it reads the name, and the Super Admin's only when it never does (owner, 2026-10-17).
 *
 * His words on the Place checks page, looking at the photos filed "Not readable": *"how come any
 * unreadable should be not validated, should be wait until the system check and I manual approve or
 * reject"* — "I can read them. So why you cannot?" — answered "Hold; re-read; else you decide", with
 * "The system is checking" for the rep and an Approve of his own on Not confirmed. For a reading
 * service that is down: *"try to reread, try to fix, try to fall back on other way. If you couldn't
 * read them, then hold for manual review."*
 *
 * Measured that day on 40 production photos: the cheap door reader confirmed 1 of 30 a person reads at
 * a glance; the middle tier at the door, the strong blind re-read and the guided read checked by a blind
 * close look together confirmed 16 of 30, with 0 wrong names — where the guided read on its own copied
 * the name it was handed 8 times.
 */

const ROOT = new URL("../", import.meta.url);

function read(path: string): string {
  return readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n/g, "\n");
}

function check(verdict: PhoenixCrmSignboardCheck["verdict"], reason: SignboardCheckReason | null): PhoenixCrmSignboardCheck {
  return { ...signboardUnjudged("unreadable"), reason, verdict };
}

function sign(over: Partial<PhoenixCrmSign>): PhoenixCrmSign {
  return { box: null, kind: "medical", legibility: "clear", personNames: [], placeNames: [], text: null, ...over };
}

function checkTheDoorHolds(): void {
  // 🔴 Everything but a match holds at the door — an unreadable sign included, which was VALIDATED
  // until 2026-10-17 and is what filled Not confirmed.
  assert.equal(signboardDoorHolds(check("match", null)), false, "a sign that names him validates at once");
  for (const verdict of ["other_name", "no_name"] as const) {
    assert.equal(signboardDoorHolds(check(verdict, verdict === "other_name" ? "sign_other_name" : "sign_no_name")), true, `${verdict} holds`);
  }
  for (const reason of ["unreadable", "call_failed", "no_api_key", "no_bytes", "unconfirmed"] as const) {
    assert.equal(signboardDoorHolds(check("unjudged", reason)), true, `🔴 unjudged / ${reason} holds at the door now — the system re-reads it`);
  }
  // One review row, one decision; and a name with nothing to compare has no question to re-read.
  assert.equal(signboardDoorHolds(check("unjudged", "held_elsewhere")), false, "a place Google already holds is not held twice");
  assert.equal(signboardDoorHolds(check("unjudged", "name_unusable")), false, "a name that folds away is never held on a sign");
}

function checkTheReReads(): void {
  // 🔴 TWO, NOT FOUR, SINCE 2026-10-18 (owner: re-reading the same photo is "a total wasting of money").
  // One held photo cost typically 10 and at most 13 answered calls at four reads; a photo the one
  // re-read cannot confirm is fixed by a new photo, never by reading the old one again.
  assert.equal(SIGNBOARD_HELD_MAX_READS, 2, "the door's read and ONE re-read");
  assert.equal(heldSignboardOutcome(check("match", null), 1), "approve", "a confirmed reading approves");
  assert.equal(heldSignboardOutcome(check("match", null), SIGNBOARD_HELD_MAX_READS), "approve", "even on the last read");
  assert.equal(heldSignboardOutcome(check("unjudged", "unreadable"), 1), "again", "the door's read alone: one re-read left");
  assert.equal(heldSignboardOutcome(check("unjudged", "unreadable"), 2), "done", "the one re-read spent: it is his");
  assert.equal(heldSignboardOutcome(check("unjudged", "unreadable"), 4), "done", "a place counted under the old four stays done");
  assert.equal(heldSignboardOutcome(check("other_name", "sign_other_name"), 2), "done", "the system never rejects — a negative is his too");

  // The count lives on the row, so a crash cannot reset it.
  assert.equal(signboardReadsRecorded(null), 0, "no check is no read");
  assert.equal(signboardReadsRecorded({ verdict: "unjudged" }), 1, "a check from before the count had one read");
  assert.equal(signboardReadsRecorded({ attempts: 3 }), 3);

  const spent = heldSignboardCheckToKeep(check("unjudged", "unreadable"), 2, "done");
  assert.equal(spent.attempts, 2, "the count is written");
  assert.equal(spent.reason, "unreadable_final", "and the last unreadable read says every read was spent");
  assert.equal(heldSignboardCheckToKeep(check("unjudged", "unreadable"), 1, "again").reason, "unreadable", "not before it");
  assert.equal(heldSignboardCheckToKeep(check("unjudged", "call_failed"), 2, "done").reason, "call_failed", "a lost call is never called unreadable");

  // 🔴 A READER THAT NEVER ANSWERED READ NOTHING (18 Oct 2026, 01:00 Cairo: the AI account ran out of
  //    credit and 241 re-reads came back `call_failed`). Counted, every held place would spend its four
  //    reads in a few hours and page him once each for a photograph nobody looked at.
  assert.equal(heldSignboardReadHappened(check("unjudged", "call_failed")), false, "a lost call spends no read");
  assert.equal(heldSignboardReadHappened(check("unjudged", "no_api_key")), false, "nor does a missing key");
  for (const reason of ["unreadable", "no_bytes", "unconfirmed"] as const) {
    assert.equal(heldSignboardReadHappened(check("unjudged", reason)), true, `unjudged / ${reason} is a read that answered`);
  }
  assert.equal(heldSignboardReadHappened(check("other_name", "sign_other_name")), true);
  assert.equal(heldSignboardReadHappened(check("match", null)), true);
  // The run stops asking a reader that is down — but never because one photo's calls keep failing.
  assert.equal(heldSignboardReaderIsDown({ answered: 0, unread: 3 }), true, "three unread and nothing answered: the reader is down");
  assert.equal(heldSignboardReaderIsDown({ answered: 0, unread: 2 }), false, "two may be two bad photographs");
  assert.equal(heldSignboardReaderIsDown({ answered: 1, unread: 9 }), false, "a reader that answered once is up");

  const still = { isTest: false, pending: true, signboardHold: true, stored: { attempts: 1 } };
  assert.equal(signboardHoldStillReading(still), true, "a held sign with its re-read still to come is still being read");
  assert.equal(signboardHoldStillReading({ ...still, stored: { attempts: 2 } }), false, "not once the re-read is spent");
  assert.equal(signboardHoldStillReading({ ...still, pending: false }), false, "nor once it is decided");
  assert.equal(signboardHoldStillReading({ ...still, signboardHold: false }), false, "nor for a Google or a timetable hold");
  assert.equal(signboardHoldStillReading({ ...still, isTest: true }), false, "nor a test entry, which the hourly pass never reads");
}

function checkTheNameMustBeRead(): void {
  // 🔴 The owner's AM rule makes a frame whose clear signs name no place a MATCH — right for a blind
  // read, and the exact hole a STEERED read would walk through: a close look that read only
  // "صيدلية" would confirm whatever name the guided read was handed.
  const am = { customerName: "مستشفى النور التخصصي", listType: "AM" as const };
  const pharmacyOnly = [sign({ text: "صيدلية" })];
  assert.equal(
    judgeSignboards({ croppedFraction: 0.18, note: null, signPresent: true, signs: pharmacyOnly, ...am }).verdict,
    "match",
    "the AM rule alone calls this a match",
  );
  assert.equal(signboardReadsCustomerName(pharmacyOnly, am), false, "🔴 but it never READ his name, so a guided answer is not confirmed by it");
  assert.equal(signboardReadsCustomerName([sign({ placeNames: ["مستشفى النور التخصصي"], text: "مستشفى النور التخصصي" })], am), true, "his name, read");

  const pm = { customerName: "احمد سمير عبدالله", listType: "PM" as const };
  assert.equal(signboardReadsCustomerName([sign({ personNames: ["د. احمد سمير"], text: "د. احمد سمير" })], pm), true);
  assert.equal(signboardReadsCustomerName([sign({ personNames: ["د. محمود حسن"], text: "د. محمود حسن" })], pm), false, "another person is not him");
}

function checkTheDoorPaths(): void {
  const list = stripComments(read("src/lib/phoenix-crm/server/list.ts"));
  assert.ok(!list.includes("signboardHoldsForReview"), "🔴 the door no longer asks the narrow question");
  // Since 2026-10-18 both doors hold through the scanner's own answer (`signboardDoorAction`), which
  // refuses a photo with no readable name up to twice first and holds on anything else but a match.
  assert.equal(list.split("signboard.holds").length - 1, 2, "both doors — a first validation and another clinic — hold on the scanner's answer");
  assert.ok(list.includes('holds: action.kind !== "save"'), "and the scanner's answer is its door action, never a second rule");
  assert.equal(list.split("await settleHeldSignboard(").length - 1, 2, "and both re-read it straight after the reply");
  assert.equal(list.split("&& !signboardHold) {").length - 1, 2, "neither tells the Super Admin at the door: the system has not finished");

  // The re-read runs AFTER the reply and AFTER the door's own verdict is recorded, so its count is 2.
  const validate = list.slice(list.indexOf('afterResponse("phoenix-crm validate: post-save records"'));
  assert.ok(validate.indexOf("recordPlaceSignboard(validated.placeId") < validate.indexOf("await settleHeldSignboard("), "validate: recorded, then re-read");
  const added = list.slice(list.indexOf('afterResponse("phoenix-crm add place: post-save records"'));
  assert.ok(added.indexOf("recordPlaceSignboard(added.placeId") < added.indexOf("await settleHeldSignboard("), "add place: recorded, then re-read");

  const venues = stripComments(read("src/lib/phoenix-crm/server/shared-places.ts"));
  assert.ok(venues.includes("signboardDoorHolds(signboard)"), "a building is held on anything but a match too");
  assert.ok(!venues.includes("signboard-holds"), "🔴 but a building is never re-read or approved by the system — his decision alone");
}

function checkTheSystemOnlyApproves(): void {
  const holds = stripComments(read("src/lib/phoenix-crm/server/signboard-holds.ts"));
  assert.ok(holds.includes('decision: "approve"'), "the system approves a confirmed hold");
  assert.ok(!holds.includes('decision: "reject"'), "🔴 and never rejects — a frame nobody can read is the Super Admin's");
  assert.ok(holds.includes("actor_hr_id: SIGNBOARD_SYSTEM_ACTOR"), "as the SYSTEM, through the same RPC his own button runs");
  assert.ok(!holds.includes("phoenix_crm_shared_places"), "never a building");
  assert.ok(holds.includes('.eq("google->>verdict", "signboard")'), "only a SIGNBOARD hold — never a Google or a timetable one");
  assert.ok(holds.includes('.eq("is_test", false)'), "real entries only on the hourly pass");
  const unreadAt = holds.indexOf('if (!heldSignboardReadHappened(read)) return "unread";');
  assert.ok(unreadAt > 0 && unreadAt < holds.indexOf("const reads = place.readsSoFar + 1"), "a lost call or a missing key spends no read");
  const breakerAt = holds.indexOf("heldSignboardReaderIsDown({ answered: result.read, unread: result.unread })");
  assert.ok(
    breakerAt > 0 && breakerAt < holds.indexOf("const settled = await settleHeldSignboard(place"),
    "the hourly run asks whether the reader is down before every place",
  );
  const unreadCountAt = holds.indexOf('if (settled === "unread")');
  assert.ok(
    unreadCountAt > 0 && unreadCountAt < holds.indexOf("result.read += 1"),
    "and an unread place is never counted as a read that answered",
  );
  const reader = stripComments(read("src/lib/phoenix-crm/server/signboard-check.ts"));
  const held = reader.slice(reader.indexOf("export async function rereadHeldPlaceSignboard("));
  assert.ok(
    held.includes('if (!cropped) return unjudged("no_bytes");'),
    "a photo that cannot be opened is a read that answered — it never gets better",
  );
  assert.ok(/if \(outcome === "done" && !place\.isTest && context\.seat\)/.test(holds), "he is told only when every read is spent");

  // The board shows the system's decision as a word, never as a code.
  const actor = /SIGNBOARD_SYSTEM_ACTOR = "([A-Z]+)"/.exec(holds)?.[1];
  const reviews = read("src/lib/phoenix-crm/server/validation-reviews.ts");
  const decider = /const SYSTEM_DECIDER = "([A-Z]+)"/.exec(reviews)?.[1];
  assert.ok(actor && actor === decider, "the board's word for the system is the actor the system writes");
  assert.ok(reviews.includes('? "The system"'), "and it reads 'The system'");

  // Nothing else reads a held place on its own count.
  const sweep = stripComments(read("src/lib/phoenix-crm/server/signboard-sweep.ts"));
  assert.ok(sweep.includes("loadHeldSignboardPlaceIds()"), "the night's pass reads the held set");
  assert.ok(sweep.includes("read.filter((place) => !held.has(place.placeId))"), "and leaves every held place to the held re-read");

  const cron = stripComments(read("app/api/cron/phoenix-crm-visit-rollup/route.ts"));
  assert.ok(cron.includes('afterResponse("phoenix_crm_held_signboard_recheck"'), "the hourly re-read rides the roll-up, after its reply");
  assert.ok(cron.indexOf("runPhoenixCrmVisitRollup()") < cron.indexOf("runHeldSignboardRecheck()"), "and after the roll-up itself");
}

function checkHisApprove(): void {
  const reviews = stripComments(read("src/lib/phoenix-crm/server/validation-reviews.ts"));
  const start = reviews.indexOf("export async function approveValidatedPlace(");
  assert.ok(start > 0, "the Super Admin can approve a place the system could not confirm");
  const body = reviews.slice(start, reviews.indexOf("\n}\n", start));
  assert.ok(body.indexOf("canDecideValidationReviews(viewer)") < body.indexOf("getSupabaseAdmin()"), "the Super Admin alone, before anything is read");
  assert.ok(body.includes('if (existing && existing.status !== "pending") return { placeId, approved: false };'), "a decided place is left as it is");
  assert.ok(body.includes('reason: "confirmed_by_admin"'), "the review row says he confirmed it");
  assert.ok(body.includes('{ onConflict: "place_id" }'), "an upsert on the UNIQUE place_id");
  assert.ok(body.includes('decision: "approve"') && !body.includes('decision: "reject"'), "through the one approve");

  const route = read("app/api/phoenix-crm/validation-reviews/approve/route.ts");
  assert.match(route, /assertSameOriginMutation\(request\)/, "the route checks the origin");
  assert.match(route, /assertPermission\(access, "phoenix_crm", "approve"\)/, "and the module's approve right — both deciders hold it");
  assert.match(route, /approveValidatedPlace\(viewer, await request\.json\(\)\)/, "before the service decides who may press it");
  assert.ok(read("src/lib/security/access-registry.ts").includes('pattern: "/api/phoenix-crm/validation-reviews/approve"'), "and it is in the access registry");

  const list = stripComments(read("src/components/phoenix-crm/validated-place-list.tsx"));
  assert.match(list, /mode === "team" \? null : <Approve row=\{row\} \/>/, "🔴 a district manager's board approves nothing");
  assert.ok(list.includes('"/api/phoenix-crm/validation-reviews/approve", { placeId: row.placeId, note: answer.note }'), "ticked rows approve through the same route");

  const queue = stripComments(read("src/components/phoenix-crm/validation-review-queue.tsx"));
  assert.ok(queue.includes("row.systemStillReading ?"), "Needs you says when the system is still reading a sign");
}

export async function runPhoenixCrmHeldSignboardTests(): Promise<void> {
  checkTheDoorHolds();
  checkTheReReads();
  checkTheNameMustBeRead();
  checkTheDoorPaths();
  checkTheSystemOnlyApproves();
  checkHisApprove();
  console.log("phoenix-crm held signboard: OK");
}
