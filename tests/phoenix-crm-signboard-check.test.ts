import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  judgeSignboard,
  SIGNBOARD_CROP_MIN_FRACTION,
  signboardApplies,
  signboardHoldRecord,
  signboardHoldsForReview,
  signboardNameIsUsable,
  signboardUnjudged,
  signNamesCustomer,
  stampBandFraction,
} from "../src/lib/phoenix-crm/signboard-rules.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — the signboard check (owner, 2026-10-08).
 *
 * The module validated a LOCATION while the owner graded an IDENTIFICATION: of 643 places validated
 * in five days, 179 photographs showed no building, a blank wall, paper or a car window, and 561 got
 * no identity check of any kind. His rulings, each pinned here as behaviour:
 *
 *   1. Require the customer's name always — a confident "no signboard at all" HOLDS.
 *   7. "NEVER A PERSON — AM SIGN / PM SIGN": an AM capture is judged on the place name only, and an AM
 *      sign naming nobody is a MATCH; a PM capture is judged on the person.
 *
 * And the module's own safety property: NO ANSWER NEVER HOLDS. A lapsed key or a slow model must
 * never hold every validation in the field.
 */

const judge = (overrides: Partial<Parameters<typeof judgeSignboard>[0]>) =>
  judgeSignboard({
    customerName: "احمد سمير عبدالله",
    listType: "PM",
    signPresent: true,
    signText: null,
    personNames: [],
    placeNames: [],
    note: null,
    croppedFraction: 0.18,
    ...overrides,
  });

function checkStampBand(): void {
  // 🔴 The crop must clear the camera's frame guide in BOTH canvas shapes, or a signboard framed
  // exactly where the rep was told to put it is cropped away before it is read.
  const capture = readFileSync("src/components/phoenix-crm/live-photo-capture.tsx", "utf8");
  const bottom = Number(/const SIGNBOARD_FRAME_BOTTOM = ([0-9.]+);/.exec(capture)?.[1]);
  assert.ok(bottom > 0 && bottom < 1, "the frame guide's bottom edge is a fraction of the frame");
  const portrait = stampBandFraction(720, 1280);
  const landscape = stampBandFraction(1280, 720);
  assert.equal(portrait, SIGNBOARD_CROP_MIN_FRACTION, "portrait clamps to the one-line floor");
  assert.equal(landscape, 0.4917, "landscape crops the eight-line worst case");
  assert.ok(1 - portrait > bottom, "portrait: the crop never reaches the framed signboard");
  assert.ok(1 - landscape > bottom, "landscape: the crop never reaches the framed signboard");

  // The crop restates drawStamp line for line; if one changes without the other this goes red.
  for (const line of [
    "Math.max(16, Math.round(canvas.width * 0.022))",
    "Math.round(fontSize * 1.38)",
    "Math.round(fontSize * 0.75)",
  ]) {
    assert.ok(capture.includes(line), `drawStamp still computes ${line}`);
  }
  assert.equal(stampBandFraction(0, 0), 0.6, "a frame with no size crops the maximum, never nothing");
}

function checkVerdicts(): void {
  // Ruling 1: no signboard at all, said confidently, holds — on either list.
  for (const listType of ["PM", "AM"] as const) {
    const none = judge({ listType, signPresent: false });
    assert.equal(none.verdict, "no_name", `${listType}: a photo with no signboard is held`);
    assert.equal(signboardHoldsForReview(none), true);
  }
  // But an UNSURE model (null) never holds.
  const unsure = judge({ signPresent: null });
  assert.equal(unsure.verdict, "unjudged", "unsure is unjudged");
  assert.equal(signboardHoldsForReview(unsure), false, "and unjudged never holds");

  // Ruling 7, AM half: an AM sign naming no place is a match, whoever it names.
  const amPeopleOnly = judge({ listType: "AM", personNames: ["د. محمد علي"], signText: "د. محمد علي" });
  assert.equal(amPeopleOnly.verdict, "match", "an AM sign that names nobody's place is a match — never judged on a person");
  // AM: the place name is what is read.
  const amPlace = judge({ listType: "AM", customerName: "مستشفى النور التخصصي", placeNames: ["مستشفى النور التخصصي"] });
  assert.equal(amPlace.verdict, "match");
  const amOtherPlace = judge({ listType: "AM", customerName: "مستشفى النور التخصصي", placeNames: ["مركز الشفاء الطبي"] });
  assert.equal(amOtherPlace.verdict, "other_name", "an AM sign naming a different place is held");

  // PM: the person is what is read, honorifics folded away.
  const pmMatch = judge({ personNames: ["د. احمد سمير"], signText: "د. احمد سمير" });
  assert.equal(pmMatch.verdict, "match", "a three-token name may lose one token; the honorific is folded");
  const pmOther = judge({ personNames: ["د. محمود حسن"], signText: "د. محمود حسن" });
  assert.equal(pmOther.verdict, "other_name");
  assert.equal(pmOther.reason, "sign_other_name");
  const pmPlaceOnly = judge({ placeNames: ["مركز الشفاء الطبي"] });
  assert.equal(pmPlaceOnly.verdict, "no_name", "a PM sign naming only a place has no nameplate for the person");

  // The name test on its own: a two-token name must find both tokens.
  assert.equal(
    signNamesCustomer({ customerName: "احمد سمير", listType: "PM", personNames: ["احمد حسن"], placeNames: [], signText: null }).matches,
    false,
    "a shared first name is not the customer",
  );
  assert.equal(
    signNamesCustomer({ customerName: "احمد سمير", listType: "PM", personNames: [], placeNames: [], signText: null }).matches,
    null,
    "nothing read is an absence, never a mismatch",
  );
  assert.equal(signboardNameIsUsable("احمد"), false, "a one-token name is not evidence");
  assert.equal(signboardNameIsUsable("احمد سمير"), true);
  assert.equal(signboardApplies("Pharmacy"), false, "a pharmacy is never asked");
  assert.equal(signboardApplies("PM") && signboardApplies("AM"), true);
}

function checkRecords(): void {
  const unjudged = signboardUnjudged("call_failed");
  assert.equal(unjudged.verdict, "unjudged");
  assert.equal(unjudged.reason, "call_failed", "an absence always says WHY, so NOT CHECKED never reads as CLEAN");

  const record = signboardHoldRecord(judge({ personNames: ["د. محمود حسن"] }), { lat: 30, lon: 31, accuracyMeters: 9, source: "photo" });
  assert.equal(record.verdict, "signboard", "the review row says which detector held it");
  assert.deepEqual(record.listings, [], "an empty listing list, never a missing key, for the queue loader");
}

function checkServerAndSweep(): void {
  const server = stripComments(readFileSync("src/lib/phoenix-crm/server/signboard-check.ts", "utf8"));
  assert.ok(server.includes("PHOENIX_CRM_SIGNBOARD_TIMEOUT_MS = 8_000"), "a rep at the door waits eight seconds at most");
  assert.ok(server.includes('await import("sharp")'), "sharp is loaded lazily, never at the top of a route-reachable file");
  assert.ok(server.includes("downloadIssuedPlacePhoto"), "a save reads only a path the server issued to this person");
  assert.ok(/Set sign_present to false only when/.test(readFileSync("src/lib/phoenix-crm/server/signboard-check.ts", "utf8")), "the prompt asks for false only when sure");

  // The nightly pass never holds, never un-validates, and tells nobody.
  const sweep = stripComments(readFileSync("src/lib/phoenix-crm/server/signboard-sweep.ts", "utf8"));
  for (const banned of ["hold_review", "validation_reviews", "notifyPhoenixCrm", "status:"]) {
    assert.ok(!sweep.includes(banned), `the signboard sweep never touches ${banned}`);
  }
  assert.ok(sweep.includes('.order("captured_at", { ascending: true })'), "oldest first, so an old backlog is never left behind");
  assert.ok(sweep.includes('.neq("customer.list_type", "Pharmacy")'), "pharmacies are excluded at the database");
  assert.ok(sweep.includes('.eq("is_test", false)'), "real entries only");
  assert.ok(sweep.includes("filePlaceSignboardFlag"), "a confident negative is FILED as a case for the board");

  const dupes = readFileSync("src/lib/phoenix-crm/server/photo-dupes.ts", "utf8");
  const photos = dupes.indexOf("runPhoenixCrmPhotoSweep({ limit: options.limit })");
  const signs = dupes.indexOf("runPhoenixCrmSignboardSweep()");
  const behaviour = dupes.indexOf("runPhoenixCrmBehaviourSweep({ today: options.today })");
  assert.ok(photos > 0 && photos < signs && signs < behaviour, "photos, then signboards, then the month's shape");
}

/**
 * How fast the nightly pass is allowed to be, and what stops it.
 *
 * MEASURED ON PRODUCTION, 2026-10-09: the first night read its 60 places between 03:35:04 and
 * 03:35:45 Cairo — 42 seconds, from the `checkedAt` stamps the pass itself wrote — and stopped on
 * its LIMIT with 547 places still waiting. The owner raised the limit that day. What has to stay
 * true afterwards is not the number but the shape: the BUDGET is what ends a normal night, and the
 * whole pass still fits well inside the cron window with the behaviour pass left its room.
 *
 * Read out of the source rather than imported: this module reaches Supabase and the OpenAI client at
 * import time, and the rest of this file deliberately reads it as text for the same reason.
 */
function checkSweepRate(): void {
  const source = readFileSync("src/lib/phoenix-crm/server/signboard-sweep.ts", "utf8");
  const number = (name: string): number => {
    const found = source.match(new RegExp(`export const ${name} = ([0-9_]+)`));
    assert.ok(found, `${name} must still be an exported literal — this gate reads it out of the source`);
    return Number(found[1].replace(/_/g, ""));
  };
  const limit = number("SIGNBOARD_SWEEP_LIMIT");
  const budgetMs = number("SIGNBOARD_SWEEP_BUDGET_MS");
  const concurrency = number("SIGNBOARD_SWEEP_CONCURRENCY");
  const perReadTimeoutMs = Number(
    readFileSync("src/lib/phoenix-crm/server/signboard-check.ts", "utf8")
      .match(/PHOENIX_CRM_SIGNBOARD_TIMEOUT_MS = ([0-9_]+)/)?.[1]
      .replace(/_/g, "") ?? NaN,
  );

  /** 60 reads in 42 s, measured; four in flight. Places per second for the whole pass. */
  const MEASURED_READS_PER_SECOND = 60 / 42;

  assert.ok(
    limit >= 200,
    `the nightly limit is ${limit}: at the measured 1.4 places a second the pass used 42 s of its `
      + "120 s budget and then stopped on this number, leaving 547 places for nine more nights "
      + "(owner, 2026-10-09 — raise it)",
  );
  assert.ok(
    (limit / MEASURED_READS_PER_SECOND) * 1000 >= budgetMs,
    `the BUDGET must be what ends a normal night, not the limit: ${limit} places at the measured `
      + `rate is ${Math.round((limit / MEASURED_READS_PER_SECOND) * 1000)} ms against a ${budgetMs} ms budget. `
      + "Below that line the pass stops early with the window unused, which is the state this change undid.",
  );
  assert.ok(
    budgetMs + perReadTimeoutMs <= 150_000,
    `the pass may start a read right before the deadline, so its worst case is ${budgetMs + perReadTimeoutMs} ms; `
      + "the cron's maxDuration is 300 s and the photo and behaviour passes share it, so half is the ceiling",
  );
  assert.ok(limit <= 500, "the in-function clamp is 500 — a default above it would be silently cut");
  assert.ok(
    /Math\.min\(options\.limit \?\? SIGNBOARD_SWEEP_LIMIT, 500\)/.test(source),
    "that clamp must stay, so a caller's limit cannot run the pass past the cron window",
  );
  assert.equal(concurrency, 4, "reads in flight are unchanged — the raise buys nights, never parallel load");
}

export function runPhoenixCrmSignboardCheckTests(): void {
  checkStampBand();
  checkVerdicts();
  checkRecords();
  checkServerAndSweep();
  checkSweepRate();
  console.log("phoenix-crm signboard check: OK");
}
