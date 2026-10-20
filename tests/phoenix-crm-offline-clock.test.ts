import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ANCHOR_MAX_AGE_SECONDS,
  ELAPSED_TOLERANCE_SECONDS,
  OFFLINE_GAP_NOTABLE_SECONDS,
  cairoDayOf,
  deriveOfflineCaptureTime,
  parseOfflineCaptureClaim,
  type OfflineCaptureClaim,
  type TimeAnchorRecord,
} from "../src/lib/phoenix-crm/offline-clock.ts";
import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — a trustworthy Cairo time for a visit captured with no signal (A1, phase 1).
 *
 * The owner's own specification, 2026-09-27, when he was offered the phone's clock or the sync
 * time and refused both:
 *
 *   "I want the Cairo time, but I don't want the time on the phone because they may install an app
 *    that changes the time in the phone. I need what protects the system from fraud, but at the
 *    same time I need it to be accurate Cairo time."
 *
 * So the phone never sends a time. It sends a DURATION, measured on the monotonic clock — the one
 * a "change my time" app cannot touch — against an ANCHOR the server wrote and can look up.
 *
 * ## The five things that would be wrong quietly
 *
 *   1. **Reading the wall clock anywhere.** If a timestamp from the phone reaches the calculation,
 *      the whole design is decorative and the owner's exact objection is live again.
 *   2. **An unbounded duration.** The phone cannot lie about the starting point, so it would lie
 *      about the length. The server knows when it issued the anchor and when the visit arrived, so
 *      the claim must fit inside that window — a bound made of physics, not of trust.
 *   3. **A delta measured across a reboot.** The monotonic clock resets to zero on boot, so a
 *      delta spanning one measures nothing at all.
 *   4. **A borrowed anchor.** One issued to another rep, or another territory, would let a phone at
 *      home date a visit into somebody else's morning.
 *   5. **The arrival time deciding the day.** A visit captured at 19:00 and synced at 02:00 belongs
 *      to the 19:00 day. Reaching for the arrival time undoes the entire feature.
 */

const ROOT = new URL("../", import.meta.url);

function source(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8"));
}

const ISSUED = new Date("2026-09-27T06:00:00Z");

function anchor(patch: Partial<TimeAnchorRecord> = {}): TimeAnchorRecord {
  return { anchorId: "A-1", issuedAt: ISSUED, hrId: "B-200", seatId: "FAISAL", bootId: "boot-1", isTest: false, ...patch };
}

function claim(patch: Partial<OfflineCaptureClaim> = {}): OfflineCaptureClaim {
  return { anchorId: "A-1", elapsedMs: 90 * 60 * 1000, bootId: "boot-1", ...patch };
}

function context(receivedAt: string) {
  return { receivedAt: new Date(receivedAt), hrId: "B-200", seatId: "FAISAL" };
}

export function runPhoenixCrmOfflineClockTests(): void {
  // ── 1. The ordinary offline morning ────────────────────────────────────────────────────────────
  //
  // Anchored at 06:00 with signal, photographed 90 minutes later in a dead spot, synced at 11:00.
  {
    const verdict = deriveOfflineCaptureTime(anchor(), claim(), context("2026-09-27T11:00:00Z"));
    assert.equal(verdict.ok, true);
    if (!verdict.ok) return;
    assert.equal(verdict.capturedAt.toISOString(), "2026-09-27T07:30:00.000Z", "the anchor plus the elapsed time, and nothing else");
    assert.equal(verdict.offlineSeconds, 3.5 * 60 * 60, "and the gap it waited is recorded");
    assert.equal(verdict.clamped, false);
    assert.equal(verdict.notable, false, `3.5 hours is an ordinary dead spot, well inside ${OFFLINE_GAP_NOTABLE_SECONDS / 3600}h`);
  }

  // ── 2. 🔴 THE PHONE'S WALL CLOCK IS NEVER READ — the owner's whole objection ───────────────────
  //
  // The module takes no timestamp from the phone, so there is nothing for a clock app to move. The
  // proof is structural rather than behavioural: the claim type has no time field, and the source
  // reads no clock of its own.
  {
    const clockSource = source("src/lib/phoenix-crm/offline-clock.ts");
    for (const forbidden of ["Date.now()", "new Date()"]) {
      assert.equal(
        clockSource.includes(forbidden),
        false,
        `🔴 offline-clock.ts must not read any clock of its own (${forbidden}) — every time in the answer comes from the SERVER's anchor or the SERVER's receipt`,
      );
    }
    // The claim carries a duration and an identity. If a timestamp is ever added to it, the phone
    // is being trusted again and the owner's objection is live.
    const claimType = clockSource.slice(clockSource.indexOf("export type OfflineCaptureClaim"), clockSource.indexOf("export type OfflineClockContext"));
    for (const word of ["capturedAt", "timestamp", "wallClock", "deviceTime"]) {
      assert.equal(claimType.includes(word), false, `🔴 the phone must send no time at all — found ${word} on the claim`);
    }
    assert.ok(claimType.includes("elapsedMs"), "only a duration");

    // And the same visit, sent by a phone whose clock is three hours wrong, lands identically —
    // because the wrong clock is not one of the inputs.
    const honest = deriveOfflineCaptureTime(anchor(), claim(), context("2026-09-27T11:00:00Z"));
    const clockMovedBackThreeHours = deriveOfflineCaptureTime(anchor(), claim({ bootId: "boot-1" }), context("2026-09-27T11:00:00Z"));
    assert.equal(honest.ok && clockMovedBackThreeHours.ok, true);
    if (honest.ok && clockMovedBackThreeHours.ok) {
      assert.equal(honest.capturedAt.toISOString(), clockMovedBackThreeHours.capturedAt.toISOString(), "the phone's clock is not an input");
    }
  }

  // ── 3. 🔴 THE BOUND MADE OF PHYSICS — a duration cannot exceed the window the server can prove ─
  {
    // Anchor at 06:00, arrival at 11:00: the server knows five hours passed. Six is impossible.
    const overclaim = deriveOfflineCaptureTime(anchor(), claim({ elapsedMs: 6 * 60 * 60 * 1000 }), context("2026-09-27T11:00:00Z"));
    assert.equal(overclaim.ok, false, "🔴 six hours of elapsed time inside a five-hour window is impossible, not merely suspicious");
    if (!overclaim.ok) assert.equal(overclaim.refusal, "elapsed_impossible", "🔴 the server brackets the window at both ends itself");

    // Honest rounding just past the edge is pulled BACK to the edge, never refused and never pushed
    // out. A correction can only ever move a claim towards the truth.
    const justOver = deriveOfflineCaptureTime(
      anchor(),
      claim({ elapsedMs: (5 * 60 * 60 + ELAPSED_TOLERANCE_SECONDS - 10) * 1000 }),
      context("2026-09-27T11:00:00Z"),
    );
    assert.equal(justOver.ok, true);
    if (justOver.ok) {
      assert.equal(justOver.clamped, true, "inside tolerance, so corrected rather than refused");
      assert.equal(justOver.capturedAt.toISOString(), "2026-09-27T11:00:00.000Z", "pulled back to the arrival, never past it");
      assert.equal(justOver.offlineSeconds, 0);
    }

    // Time running backwards is not rounding.
    const negative = deriveOfflineCaptureTime(anchor(), claim({ elapsedMs: -1 }), context("2026-09-27T11:00:00Z"));
    assert.equal(negative.ok, false);
    if (!negative.ok) assert.equal(negative.refusal, "elapsed_negative");

    const nonsense = deriveOfflineCaptureTime(anchor(), claim({ elapsedMs: Number.NaN }), context("2026-09-27T11:00:00Z"));
    assert.equal(nonsense.ok, false);
  }

  // ── 4. 🔴 A reboot resets the stopwatch, so a delta across one measures nothing ────────────────
  {
    const rebooted = deriveOfflineCaptureTime(anchor({ bootId: "boot-1" }), claim({ bootId: "boot-2" }), context("2026-09-27T11:00:00Z"));
    assert.equal(rebooted.ok, false);
    if (!rebooted.ok) assert.equal(rebooted.refusal, "rebooted");

    // 🔴 Unknown is not equal. A build that cannot report a boot id is not evidence of a reboot,
    // and treating two nulls as a match would wave a real reboot straight through.
    const bothUnknown = deriveOfflineCaptureTime(anchor({ bootId: null }), claim({ bootId: null }), context("2026-09-27T11:00:00Z"));
    assert.equal(bothUnknown.ok, true, "an old build still works, on the bounds alone");
    const oneUnknown = deriveOfflineCaptureTime(anchor({ bootId: "boot-1" }), claim({ bootId: null }), context("2026-09-27T11:00:00Z"));
    assert.equal(oneUnknown.ok, true, "and a half-known pair is judged on the bounds, not accused");
  }

  // ── 5. A borrowed anchor ──────────────────────────────────────────────────────────────────────
  {
    const someoneElses = deriveOfflineCaptureTime(anchor({ hrId: "B-999" }), claim(), context("2026-09-27T11:00:00Z"));
    assert.equal(someoneElses.ok, false, "🔴 another rep's anchor would let a phone at home date a visit into somebody else's morning");
    if (!someoneElses.ok) assert.equal(someoneElses.refusal, "anchor_not_his");

    const otherTerritory = deriveOfflineCaptureTime(anchor({ seatId: "TANTA" }), claim(), context("2026-09-27T11:00:00Z"));
    assert.equal(otherTerritory.ok, false, "and so would another territory's");
    if (!otherTerritory.ok) assert.equal(otherTerritory.refusal, "anchor_not_his");

    // Case in an HR id is not a different person — they are upper-cased everywhere else too.
    const lowerCase = deriveOfflineCaptureTime(anchor({ hrId: "b-200" }), claim(), context("2026-09-27T11:00:00Z"));
    assert.equal(lowerCase.ok, true, "b-200 and B-200 are one rep");

    const missing = deriveOfflineCaptureTime(null, claim(), context("2026-09-27T11:00:00Z"));
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.refusal, "no_anchor");
  }

  // ── 6. An anchor goes stale, and a long wait is noted rather than refused ─────────────────────
  {
    const old = deriveOfflineCaptureTime(
      anchor(),
      claim({ elapsedMs: 1000 }),
      context(new Date(ISSUED.getTime() + (ANCHOR_MAX_AGE_SECONDS + 60) * 1000).toISOString()),
    );
    assert.equal(old.ok, false);
    if (!old.ok) assert.equal(old.refusal, "anchor_too_old", `past ${ANCHOR_MAX_AGE_SECONDS / 3600}h the monotonic delta has drifted too far to trust`);

    // A visit held overnight is ACCEPTED — it still counts, it is simply worth a manager's eye.
    const overnight = deriveOfflineCaptureTime(
      anchor(),
      claim({ elapsedMs: 30 * 60 * 1000 }),
      context(new Date(ISSUED.getTime() + 15 * 60 * 60 * 1000).toISOString()),
    );
    assert.equal(overnight.ok, true);
    if (overnight.ok) {
      assert.equal(overnight.notable, true, "a 14-hour wait is notable");
      assert.equal(overnight.capturedAt.toISOString(), "2026-09-27T06:30:00.000Z", "and it is still dated at the door, not at the sync");
    }
  }

  // ── 7. 🔴 The day is the capture's, never the arrival's ───────────────────────────────────────
  //
  // 19:00 Cairo on the 27th, synced at 02:00 Cairo on the 28th. The visit belongs to the 27th, and
  // anything that reaches for the arrival time moves a rep's whole day into the wrong week.
  {
    const eveningAnchor = anchor({ issuedAt: new Date("2026-09-27T15:00:00Z") }); // 18:00 Cairo
    const verdict = deriveOfflineCaptureTime(
      eveningAnchor,
      claim({ elapsedMs: 60 * 60 * 1000 }),
      { receivedAt: new Date("2026-09-27T23:00:00Z"), hrId: "B-200", seatId: "FAISAL" }, // 02:00 Cairo, the 28th
    );
    assert.equal(verdict.ok, true);
    if (!verdict.ok) return;
    assert.equal(cairoDayOf(verdict.capturedAt), "2026-09-27", "🔴 the visit files under the day it was captured");
    assert.equal(cairoDayOf(new Date("2026-09-27T23:00:00Z")), "2026-09-28", "even though it arrived on the next one");
  }

  // ── 8. Nothing here can ever reach a rep ──────────────────────────────────────────────────────
  {
    const clockSource = source("src/lib/phoenix-crm/offline-clock.ts");
    // The refusal wording is for the board. If any of it were rendered at a rep it would teach him
    // both that a check exists and which one caught him.
    assert.ok(clockSource.includes("OFFLINE_CLOCK_LABELS"), "the wording is one exported record, so its audience is auditable");
    assert.ok(
      /Golden Rule #1/.test(readFileSync(new URL("src/lib/phoenix-crm/offline-clock.ts", ROOT), "utf8")),
      "and the file states whose rule keeps it off his screen",
    );
  }

  // ── 9. 🔴 The anchor is the SERVER's timestamp, and nothing can reach it (phase 2) ─────────────
  {
    const migration = stripSqlComments(
      readFileSync(new URL("supabase/migrations/20260927190000_phoenix_crm_time_anchors.sql", ROOT), "utf8"),
    );
    assert.ok(
      migration.includes("issued_at timestamptz not null default now()"),
      "🔴 the anchor's time is DEFAULTED BY THE DATABASE — that is what stops a request body ever setting it",
    );
    assert.ok(migration.includes("boot_id text"), "and the restart id rides with it, so a reset stopwatch is detectable");
    assert.equal(migration.includes("used_at"), false, "an anchor is NOT single-use — one dates a whole offline stretch; age is the bound");

    const service = source("src/lib/phoenix-crm/server/time-anchor.ts");
    // 🔴 The insert must not name issued_at at all. Naming it, even from the server's own clock,
    // would put the value on a code path a body could one day be threaded into.
    const insert = service.slice(service.indexOf(".insert({"), service.indexOf(".select(\"id, issued_at\")"));
    assert.equal(insert.includes("issued_at"), false, "🔴 the insert never writes issued_at — the column default is the only writer");
    for (const forbidden of ["Date.now()", "new Date()"]) {
      const body = service.slice(service.indexOf("export async function issueTimeAnchor"), service.indexOf("export async function readTimeAnchor"));
      assert.equal(
        body.includes(forbidden) && !body.includes("60 * 60 * 1000"),
        false,
        `${forbidden} may appear only for the rate-limit window, never to stamp an anchor`,
      );
    }
    assert.ok(service.includes("territoryForVisit"), "gated like entering a visit, so a manager in a dead spot is not locked out of a double visit");
    assert.ok(service.includes("ANCHORS_PER_HOUR"), "and rate-limited, like the photo slot it accompanies");
    assert.ok(service.includes("return null"), "an unknown anchor is null, so the refusal stays a silent verdict rather than an error on a phone");

    const route = source("app/api/phoenix-crm/time-anchor/route.ts");
    assert.ok(route.includes('assertPermission(access, "phoenix_crm", "create")'), "the route carries the same permission as the photo slot");
    assert.ok(route.includes("assertSameOriginMutation"), "and the same CSRF guard");
  }

  // ── 10. The claim is parsed in ONE place and carries no timestamp (phase 3) ────────────────────
  {
    // An ordinary claim.
    const good = parseOfflineCaptureClaim({ offline: { anchorId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", elapsedMs: 5000, bootId: "b1" } });
    assert.deepEqual(good, { anchorId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", elapsedMs: 5000, bootId: "b1" });

    // 🔴 A body that smuggles a timestamp is not partially honoured — the parser has no field for it,
    // so it is simply never looked at. This is the structural form of the owner's requirement.
    const smuggled = parseOfflineCaptureClaim({
      offline: { anchorId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", elapsedMs: 5000, capturedAt: "2020-01-01T00:00:00Z", now: 123 },
    });
    assert.deepEqual(Object.keys(smuggled ?? {}).sort(), ["anchorId", "bootId", "elapsedMs"], "🔴 three fields, and there is no fourth");

    // An online save names no anchor, and rubbish is null rather than an error — the visit then dates
    // by the photo slot exactly as it always did and the rep is told nothing.
    assert.equal(parseOfflineCaptureClaim({}), null, "an online save");
    assert.equal(parseOfflineCaptureClaim({ offline: { anchorId: "not-a-uuid", elapsedMs: 1 } }), null);
    assert.equal(parseOfflineCaptureClaim({ offline: { anchorId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", elapsedMs: -5 } }), null);
  }

  // ── 11. The save DERIVES the time; it never copies one, and the database fences it again ───────
  {
    const service = source("src/lib/phoenix-crm/server/visits.ts");
    assert.ok(service.includes("parseOfflineCaptureClaim(body)"), "the claim is read through the one parser");
    assert.ok(service.includes("deriveOfflineCaptureTime("), "and judged by the pure rules");
    assert.ok(service.includes("offline_captured_at: offlineCapturedAt"), "the derived value is what reaches the database");
    // 🔴 The body must never be the source of the timestamp.
    assert.equal(service.includes("offline_captured_at: body"), false, "🔴 never copied from the request");
    assert.equal(/offline_captured_at:\s*(String\()?body/.test(service), false, "🔴 nor through a cast of it");
    // A failed derivation must not refuse the visit. 🔴 The anchor is the ASSIGNMENT, not the call:
    // since 2026-10-02 the claim is read only for the app (`client === "app" ? parse… : null`), and a
    // slice anchored on the call itself returned -1 — which slices the last CHARACTER of the file and
    // passes vacuously, so this check would have stopped biting with nothing going red.
    const regionAt = service.indexOf("const offlineClaim =");
    assert.ok(regionAt > 0, "saveVisit still reads the claim into `offlineClaim`");
    // 🔴 THE REGION IS THE DERIVATION ITSELF — from the claim to the first read after it — and not
    // everything down to the save (2026-10-20). The wider slice also covered the far-visit refusal the
    // owner ordered that day, which is a refusal about WHERE the rep stood and never about a clock, so
    // the slice measured its neighbours (`a-source-reading-test-sliced-to-the-registry-measures-its-neighbours`).
    // The original guarantee still holds over the whole stretch below: no refusal there turns on the clock.
    const saveAt = service.indexOf("offline_captured_at:", regionAt);
    const derivationEnd = service.indexOf("await Promise.all(", regionAt);
    assert.ok(derivationEnd > regionAt && derivationEnd < saveAt, "the derivation still ends before the save, at the read that follows it");
    const region = service.slice(regionAt, derivationEnd);
    assert.ok(region.includes("parseOfflineCaptureClaim(body)"), "and the region really is the derivation");
    assert.ok(region.includes("offlineCapturedAt = verdict.capturedAt"), "the whole derivation, down to the value it settles on");
    assert.equal(/throw /.test(region), false, "a clock argument must never cost a rep a real visit");
    const refusalsBeforeSave = service
      .slice(derivationEnd, saveAt)
      .split("\n")
      .filter((line) => /throw /.test(line));
    for (const line of refusalsBeforeSave) {
      assert.doesNotMatch(line, /offline|anchor|elapsed|capturedAt/i, `🔴 no refusal between the derivation and the save may turn on the clock: ${line.trim()}`);
    }

    const migration = stripSqlComments(
      readFileSync(new URL("supabase/migrations/20260927200000_phoenix_crm_offline_capture.sql", ROOT), "utf8"),
    );
    assert.ok(migration.includes("v_offline_at <= now()"), "the database refuses a capture time in the future");
    assert.ok(migration.includes("v_offline_at > now() - interval '1 day'"), "and one older than a day, as a second fence");
    // 🔴 The photo slot is untouched — it still proves the path was issued and never used.
    assert.ok(migration.includes("public.phoenix_crm_take_photo(v_photo, v_actor, v_seat, 'visit', v_is_test)"), "the slot is still consumed, unchanged");
    // 🔴 Dwell must not be computed from an offline capture time.
    assert.ok(
      /when v_source = 'offline_anchor' then null/.test(migration),
      "🔴 dwell_seconds is NULL for an offline visit — now() - captured_at would read a six-hour queue as six hours of dwell",
    );
    // The date and the planned verdict both follow the CAPTURE, which is the whole point.
    assert.ok(migration.includes("v_date := (v_captured_at at time zone 'Africa/Cairo')::date;"), "the day is the capture's");
    assert.ok(migration.includes("and e.created_at <= v_captured_at"), "and so is the planned-or-not verdict");
    assert.ok(migration.includes("synced_at"), "every visit is stamped with the server's own receipt, so the gap is readable");
  }

  console.log("phoenix-crm offline clock: OK");
}
