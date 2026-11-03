import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { parseVisitDraft } from "../src/lib/phoenix-crm/entry-rules.ts";
import { atTheDoor, checkLocationIntegrity, type PhoenixCrmPriorFix } from "../src/lib/phoenix-crm/location-integrity.ts";

/**
 * Phoenix CRM — a late save must never become a false mark against the rep (owner, 3 Nov 2026).
 *
 * A visit the phone held for want of signal arrives late, and the server dates it at arrival as it always has.
 * Two things can go wrong, and both hurt a real person who only lost signal:
 *
 *   1. THE WAIT REACHES THE DATE. `queuedSeconds` is a duration on the evidence. If it ever reached the save
 *      function, a phone could date its own visit. So it stops at the provenance row.
 *   2. THE WAIT LOOKS LIKE A TRIP. Three visits held through a dead spot arrive seconds apart, kilometres apart.
 *      Judged at arrival that reads as impossible travel, on the held visits and on the next normal one after.
 *      So the travel check compares each side at the moment the rep was there.
 */

const source = (path: string) => readFileSync(path, "utf8");
const code = (path: string) => stripComments(source(path));

const TEN_KM_NORTH = 0.09;
const CAIRO = { lat: 30.0444, lon: 31.2357 };

/** A reading the check treats as precise, on the rep's own record. */
function fixAt(iso: string, kmNorth = 0): { lat: number; lon: number; accuracyMeters: number; capturedAt: Date } {
  return { lat: CAIRO.lat + (kmNorth / 10) * TEN_KM_NORTH, lon: CAIRO.lon, accuracyMeters: 15, capturedAt: new Date(iso) };
}

function prior(fix: ReturnType<typeof fixAt>, customerId: string): PhoenixCrmPriorFix {
  return { ...fix, repHrId: "MR-0412", customerId };
}

function judge(fix: ReturnType<typeof fixAt>, history: PhoenixCrmPriorFix[]) {
  return checkLocationIntegrity({ fix, repHrId: "MR-0412", customerId: "next", deviceMocked: null, readerReplaced: null, readerFindings: [], history });
}

export function runPhoenixCrmQueuedEvidenceTests(): void {
  checkTheMarkerStopsAtTheEvidence();
  checkADrainedQueueIsNoTrip();
  checkTheWiring();
  checkTheRepIsNeverTold();
}

function checkTheMarkerStopsAtTheEvidence(): void {
  const visits = code("src/lib/phoenix-crm/server/visits.ts");

  // The marker has one road in, and only a browser may walk it.
  assert.ok(visits.includes('const queuedSeconds = client === "browser" ? visit.queuedSeconds : null;'), "only a browser has this queue");
  assert.equal(visits.split("visit.queuedSeconds").length - 1, 1, "and nothing else reads the parsed value");

  // Everything sent to the save function, by name. The block runs from the call to its closing parenthesis.
  const call = visits.indexOf('callPhoenixCrm<Row>("phoenix_crm_save_visit"');
  assert.ok(call !== -1, "the save function is called from here");
  const end = visits.indexOf("\n  });", call);
  assert.ok(end > call, "and the call has an end");
  const toTheSave = visits.slice(call, end + 1);
  // One argument may use it: the phone-clock gap, in minutes, which the save stores and dates nothing by.
  const skewArgument = /^\s*device_skew_minutes: deviceClockSkewMinutes\(.*queuedSeconds\),$/m;
  assert.ok(skewArgument.test(toTheSave), "the clock check is corrected by the wait, before the save");
  assert.equal(/queued/i.test(toTheSave.replace(skewArgument, "")), false, "🔴 nothing else near the save names the wait, so it can never date a visit");

  // The wait is not a date anywhere on the way in.
  const rules = code("src/lib/phoenix-crm/visit-resend-rules.ts");
  for (const banned of ["capturedAt", "visitDate", "time-anchor", "offlineCapturedAt"]) {
    assert.equal(rules.includes(banned), false, `the retry's rules never touch ${banned}`);
  }
  const outbox = code("src/lib/phoenix-crm/visit-outbox.ts");
  assert.equal(outbox.includes("capturedAt"), false, "the sending pass adds a duration and nothing else");

  // A forged wait is a number the server bounds, and a date is simply not one.
  const draft = {
    accuracyMeters: 15,
    comment: "Discussed the new dose.",
    customerId: "11111111-1111-4111-8111-111111111111",
    kind: "single",
    lat: CAIRO.lat,
    lon: CAIRO.lon,
    pharmacyName: "El Ezaby",
    products: ["Lacto Advanced"],
  };
  const parsedWait = (queuedSeconds: unknown): number | null => {
    const parsed = parseVisitDraft({ ...draft, queuedSeconds });
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
    return parsed.value.queuedSeconds;
  };
  assert.equal(parsedWait(600), 600, "an honest wait is read");
  assert.equal(parsedWait("2026-11-01T10:00:00.000Z"), null, "a date in the field is not a wait");
  assert.equal(parsedWait(7_201), null, "nor is anything past two hours");
  assert.equal(parsedWait(undefined), null, "and a save that never waited claims nothing");
}

function checkADrainedQueueIsNoTrip(): void {
  // A rep logged three visits ten kilometres apart through a dead spot, each an hour apart. All three arrive together.
  const arrival = "2026-11-03T12:00:00.000Z";
  const held = [
    { fix: fixAt(arrival, 0), customerId: "first", waited: 7_200 },
    { fix: fixAt("2026-11-03T12:00:03.000Z", 10), customerId: "second", waited: 3_603 },
    { fix: fixAt("2026-11-03T12:00:06.000Z", 20), customerId: "third", waited: 6 },
  ];

  // The proof the rule is worth having: compared at arrival, the same visits accuse them.
  const raw = judge(held[1]!.fix, [prior(held[0]!.fix, held[0]!.customerId)]);
  assert.ok(raw.flags.includes("impossible_travel"), "compared at arrival, a drained queue reads as an impossible trip");

  // At the door, none of them does.
  const second = judge(atTheDoor(held[1]!.fix, held[1]!.waited), [atTheDoor(prior(held[0]!.fix, held[0]!.customerId), held[0]!.waited)]);
  assert.equal(second.flags.includes("impossible_travel"), false, "🔴 the held visit is judged where and when the rep was");
  const third = judge(atTheDoor(held[2]!.fix, held[2]!.waited), [
    atTheDoor(prior(held[0]!.fix, held[0]!.customerId), held[0]!.waited),
    atTheDoor(prior(held[1]!.fix, held[1]!.customerId), held[1]!.waited),
  ]);
  assert.equal(third.flags.includes("impossible_travel"), false, "and so is the one after it");

  // The next normal visit, with no wait of its own, ten kilometres on and half an hour after the last arrival.
  const next = fixAt("2026-11-03T12:30:00.000Z", 30);
  const following = judge(next, [atTheDoor(prior(held[2]!.fix, held[2]!.customerId), held[2]!.waited)]);
  assert.equal(following.flags.includes("impossible_travel"), false, "🔴 the next normal visit is not accused for the queue before it");

  // A real impossible trip still fires. The rule shifts nothing for a save that was never held.
  const fake = judge(fixAt("2026-11-03T12:00:30.000Z", 200), [prior(fixAt("2026-11-03T12:00:00.000Z", 0), "first")]);
  assert.ok(fake.flags.includes("impossible_travel"), "two hundred kilometres in thirty seconds, with no wait claimed, still fires");

  // The pure rule.
  const fix = fixAt(arrival);
  assert.equal(atTheDoor(fix, null), fix, "a save never held is returned as it is");
  assert.equal(atTheDoor(fix, undefined), fix);
  assert.equal(atTheDoor(fix, 0), fix);
  assert.equal(atTheDoor(fix, Number.NaN), fix, "a failed read of the wait shifts nothing");
  assert.equal(atTheDoor(fix, 600).capturedAt.toISOString(), "2026-11-03T11:50:00.000Z");
  assert.equal(fix.capturedAt.toISOString(), arrival, "the fix itself is not changed");
}

function checkTheWiring(): void {
  const integrity = code("src/lib/phoenix-crm/server/location-integrity.ts");
  assert.ok(integrity.includes("fix: atTheDoor(input.fix, input.queuedSeconds)"), "the capture being judged is moved back by its own wait");
  assert.ok(integrity.includes("atTheDoor(prior, heldSeconds.get(String(row.id)))"), "and each one on record by its own");
  assert.ok(integrity.includes("captured_at: input.fix.capturedAt.toISOString()"), "what is FILED keeps the arrival, so it agrees with the visit");
  assert.ok(integrity.includes("prior.capturedAt.getTime() !== input.fix.capturedAt.getTime()"), "the capture itself is still left out of its own history");
  assert.ok(integrity.includes('"id, lat, lon, accuracy_meters, captured_at, rep_hr_id, customer_id"'), "the visit's id is read, or no wait can be matched to it");

  // The history's own row must still be recognisable, which holds because the wait is filed AFTER the judgement.
  const visits = code("src/lib/phoenix-crm/server/visits.ts");
  const judged = visits.indexOf("await judgeCapture(");
  const filed = visits.indexOf("await recordCaptureProvenance(", judged);
  assert.ok(judged !== -1 && filed > judged, "🔴 judged first, then filed: the visit being judged must not be moved back in its own history");

  // The clock check gets the same courtesy, and a truly wrong clock still shows (visit-resend-rules test).
  assert.ok(visits.includes("deviceClockSkewMinutes(visit.deviceCapturedAt, issuedAt ? new Date(issuedAt) : new Date(), queuedSeconds)"));

  const provenance = code("src/lib/phoenix-crm/server/capture-provenance.ts");
  assert.ok(provenance.includes("queued_seconds: input.queuedSeconds"), "the wait is filed on the provenance row");
}

function checkTheRepIsNeverTold(): void {
  // The rep's screen names nothing from the evidence. Its sentences live with the rules, pinned there.
  const note = code("src/components/phoenix-crm/visit-outbox-note.tsx");
  for (const banned of ["queuedSeconds", "queued_seconds", "sentLate", "clock", "distance"]) {
    assert.equal(note.toLowerCase().includes(banned.toLowerCase()), false, `the rep's note never says ${banned}`);
  }

  // The status read answers the switch, the clock and their own ids, and nothing that would teach a rep the window.
  const log = code("src/lib/phoenix-crm/server/visit-resend-log.ts");
  assert.ok(log.includes("savedVisitIds"));
  assert.equal(/\.select\([^)]*queued_seconds/.test(log), false, "the status read never reads a wait back");

  // The save's answer to the rep carries nothing about it.
  const fields = code("src/lib/phoenix-crm/visit-report-fields.ts");
  assert.ok(/F\("location", "sentLateMinutes", "Sent late \(min\)", "minutes", 10, \{ sight: "sfe", sparse: true \}\)/.test(fields), "the SFE Manager can see a forged value, and a district manager is not offered it");
}
