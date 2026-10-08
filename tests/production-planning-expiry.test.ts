import assert from "node:assert/strict";

import { parseQty } from "../src/lib/production-planning/rules.ts";
import {
  criticalDaysFor,
  daysBetweenDates,
  evaluateExpiry,
  type ExpiryLot,
  resolveExpiryArming,
} from "../src/lib/production-planning/expiry.ts";

/**
 * Production Planner — the expiry verdict, which is the owner's own reason for the lot column.
 *
 * He said it three times in one message on 2026-10-08 ("خانة الاكسبايري ديت مهمة جدا جدا جدا"), and
 * then gave the case that made it urgent: "انا عندي حاجات هتنتهي 4 27 فانا لازم انتبه لها" — he holds
 * material that dies in April 2027. The pair of Aspartame lots at the bottom of this file IS that
 * case, taken from the sheet he filled in: 124.6 kg expiring 2027-05-09 beside 23 kg expiring
 * 2029-03-19, at the same material and the same place.
 *
 * That pair is why `prodplan_stock_entries` is keyed per lot rather than per location. A summed
 * figure says "147.6 kg of Aspartame", which is true, plentiful, and cannot express the only fact he
 * asked for. The reorder alarm will never raise Aspartame — 147.6 kg against a 24 kg need — and one
 * of those lots still has to be used first.
 */

/** The base unit is the gram, so every quantity below is written in grams — 124,600 g is 124.6 kg. */
const DBK = "loc-dbk";

function lot(overrides: Partial<ExpiryLot> & Pick<ExpiryLot, "code" | "expiryDate">): ExpiryLot {
  return {
    code: overrides.code,
    expiryDate: overrides.expiryDate,
    locationId: overrides.locationId ?? DBK,
    materialId: overrides.materialId ?? `mat-${overrides.code}`,
    nameAr: overrides.nameAr ?? overrides.code,
    nameEn: overrides.nameEn ?? overrides.code,
    qty: overrides.qty ?? parseQty("10000"),
  };
}

export function runProductionPlanningExpiryTests() {
  // ── The day count ─────────────────────────────────────────────────────────────────────────────
  assert.equal(daysBetweenDates("2026-10-08", "2026-10-08"), 0, "a lot dying today has zero days left");
  assert.equal(daysBetweenDates("2026-10-08", "2026-10-09"), 1);
  assert.equal(daysBetweenDates("2026-10-08", "2027-04-27"), 201, "the April 2027 lot he named");
  assert.equal(daysBetweenDates("2026-10-08", "2026-09-30"), -8, "a date already passed is negative, never zero");
  assert.equal(daysBetweenDates("2026-01-01", "2028-01-01"), 730, "two ordinary years");
  assert.equal(daysBetweenDates("2028-01-01", "2029-01-01"), 366, "and a leap year is counted as one");

  // 🔴 Both ends parse as UTC midnight, so a window that straddles Egypt's clock change is still a
  // whole number of days. Egypt moved its clocks on 2027-04-30 and again on 2027-10-28; a mix of
  // `new Date("…")` (UTC) and `new Date(y, m, d)` (local) makes one of these 23 or 25 hours, which
  // `Math.floor` turns into an off-by-one day and `Math.round` hides completely.
  assert.equal(daysBetweenDates("2027-04-01", "2027-06-01"), 61, "across the spring change");
  assert.equal(daysBetweenDates("2027-10-01", "2027-12-01"), 61, "and across the autumn one");

  // A date JavaScript would silently roll forward is refused instead. `new Date(2028, 1, 31)` is
  // 2 March; that same roll-forward turned "three months before 31 July 2028" into 1 May while his
  // data sheet was being built, and it reached a cell before it was caught.
  assert.equal(daysBetweenDates("2026-10-08", "2028-02-31"), null, "31 February is not a date");
  assert.equal(daysBetweenDates("2026-10-08", "2026-13-01"), null, "nor is a thirteenth month");
  assert.equal(daysBetweenDates("2026-10-08", "08/10/2026"), null, "and only ISO is accepted");
  assert.equal(daysBetweenDates("2026-10-08", ""), null);

  // ── The critical band is a THIRD of his window, not a fixed 30 days ───────────────────────────
  assert.equal(criticalDaysFor(90), 30, "three months warning makes the last month critical");
  assert.equal(criticalDaysFor(180), 60);
  // A fixed 30 would swallow a short window whole and every lot would arrive already critical.
  assert.equal(criticalDaysFor(20), 6, "a twenty-day window keeps a band narrower than itself");
  assert.equal(criticalDaysFor(1), 1, "and never collapses to zero, which would make nothing critical");
  assert.equal(criticalDaysFor(0), 1);

  // ── The verdict ───────────────────────────────────────────────────────────────────────────────
  const today = "2026-10-08";
  const input = { today, warnDays: 90 };

  // 🔴 PACKAGING NEVER EXPIRES — his words, 2026-10-08: "package material no expiry date \\Aluminum
  // ,boxes & stickers". A null date is skipped, and the thing that must never happen is it being read
  // as "expires today", which would put all three packaging lines at the top of the email every day.
  const film = lot({ code: "ALU_SACHET_FILM", expiryDate: null, qty: parseQty("230950") });
  assert.deepEqual(evaluateExpiry([film], input), [], "a lot with no expiry date raises nothing");

  // A row holding nothing is not news — it is a row that was already used up.
  assert.deepEqual(
    evaluateExpiry([lot({ code: "CITRIC_ACID_ANH", expiryDate: "2026-10-09", qty: BigInt(0) })], input),
    [],
    "an empty lot raises nothing however close its date",
  );

  // The window's own edge, both sides of it.
  assert.equal(
    evaluateExpiry([lot({ code: "IN", expiryDate: "2027-01-06" })], input).length,
    1,
    "exactly 90 days out is inside a 90-day window",
  );
  assert.equal(
    evaluateExpiry([lot({ code: "OUT", expiryDate: "2027-01-07" })], input).length,
    0,
    "91 days out is not",
  );

  // The three bands.
  const bands = evaluateExpiry(
    [
      lot({ code: "WARNING", expiryDate: "2026-12-20" }), // 73 days
      lot({ code: "CRITICAL", expiryDate: "2026-10-30" }), // 22 days
      lot({ code: "TODAY", expiryDate: today }), // 0
      lot({ code: "GONE", expiryDate: "2026-09-26" }), // -12
    ],
    input,
  );
  assert.deepEqual(
    bands.map((verdict) => [verdict.code, verdict.daysLeft, verdict.severity]),
    [
      ["GONE", -12, "expired"],
      ["TODAY", 0, "expired"],
      ["CRITICAL", 22, "critical"],
      ["WARNING", 73, "warning"],
    ],
    "soonest first, and a lot dying TODAY counts as expired rather than critical — there is no time left to use it",
  );

  // Two lots dying on the same day are equally urgent whatever they hold, so the tie breaks on the
  // code and never on the quantity.
  const sameDay = evaluateExpiry(
    [
      lot({ code: "ZINC", expiryDate: "2026-11-01", qty: parseQty("900000") }),
      lot({ code: "ALPHA", expiryDate: "2026-11-01", qty: parseQty("500") }),
    ],
    input,
  );
  assert.deepEqual(sameDay.map((verdict) => verdict.code), ["ALPHA", "ZINC"]);

  // A window of zero or less raises nothing at all, rather than raising everything.
  assert.deepEqual(evaluateExpiry([lot({ code: "ANY", expiryDate: today })], { today, warnDays: 0 }), []);
  assert.deepEqual(evaluateExpiry([lot({ code: "ANY", expiryDate: today })], { today, warnDays: -90 }), []);
  assert.deepEqual(evaluateExpiry([lot({ code: "ANY", expiryDate: today })], { today, warnDays: Number.NaN }), []);

  // ── His Aspartame pair, which is the whole reason the stock table is keyed per lot ────────────
  const aspartameNear = lot({
    code: "ASPARTAME",
    expiryDate: "2027-05-09",
    materialId: "mat-ASPARTAME",
    qty: parseQty("124600"),
  });
  const aspartameFar = lot({
    code: "ASPARTAME",
    expiryDate: "2029-03-19",
    materialId: "mat-ASPARTAME",
    qty: parseQty("23000"),
  });
  // 213 days out, so nothing yet — he set three months and this is seven.
  assert.deepEqual(evaluateExpiry([aspartameNear, aspartameFar], input), [], "neither lot is in the window today");

  // Stand on 2027-03-01 and the near lot raises while the far one stays silent. One material, one
  // location, 147.6 kg held in total, and only 124.6 kg of it is the answer — which is the sentence a
  // per-location figure cannot say, and the reason the reorder alarm cannot do this job: 147.6 kg
  // against a 24 kg need is never short.
  const inMarch = evaluateExpiry([aspartameFar, aspartameNear], { today: "2027-03-01", warnDays: 90 });
  assert.equal(inMarch.length, 1, "the far lot is not dragged in by the near one");
  assert.equal(inMarch[0]!.expiryDate, "2027-05-09");
  assert.equal(inMarch[0]!.daysLeft, 69);
  assert.equal(inMarch[0]!.severity, "warning");
  assert.equal(inMarch[0]!.qty, parseQty("124600"), "and it carries ITS OWN quantity, not the material's total");

  // ── Armed only by an explicit decision, in both directions ────────────────────────────────────
  assert.deepEqual(resolveExpiryArming(null), { dryRun: true, enabled: false }, "no row at all sends nothing");
  assert.deepEqual(resolveExpiryArming({}), { dryRun: true, enabled: false }, "nor does a row with neither column");
  assert.deepEqual(resolveExpiryArming({ expiry_alarm_dry_run: null, expiry_alarm_enabled: null }), {
    dryRun: true,
    enabled: false,
  });
  // A string is what a hand-written SQL update or a half-failed read produces, and it must not arm.
  assert.deepEqual(resolveExpiryArming({ expiry_alarm_dry_run: "false", expiry_alarm_enabled: "true" }), {
    dryRun: true,
    enabled: false,
  });
  assert.deepEqual(resolveExpiryArming({ expiry_alarm_dry_run: false, expiry_alarm_enabled: true }), {
    dryRun: false,
    enabled: true,
  });
  assert.deepEqual(
    resolveExpiryArming({ expiry_alarm_dry_run: true, expiry_alarm_enabled: true }),
    { dryRun: true, enabled: true },
    "armed and still in dry run is a real state — it is how he reads what WOULD have been sent",
  );
}
