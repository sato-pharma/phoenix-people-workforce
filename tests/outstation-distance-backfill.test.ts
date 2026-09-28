import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  assertNoMoneyColumns,
  buildDistanceOnlyPayload,
  DISTANCE_ONLY_COLUMNS,
  MONEY_COLUMNS,
} from "@/lib/outstation/distance-backfill";

/**
 * "Fill the distance without touching amounts" — owner instruction, 2026-09-28.
 *
 * Eight of Weaam Mahmoud's requests (AI-0013, EGP 5,277) render "Route lookup failed" because the
 * `Number(null)` bug ran their route lookup from (0, 0). The only control that recomputed a distance
 * was the admin Edit modal, and `updateManagerExpenseAsAdmin` reprices the whole claim from it:
 * `fuelAmount = distanceKm * 2 * policy.fuelRatePerKm`, with ticket, travel cost, allowance and
 * eligibility following. So recovering a lost measurement through that path would have moved money
 * on a claim nobody asked to change.
 *
 * These tests pin the separation. The point is not that the current code writes only distance — it
 * is that it CANNOT write anything else without failing loudly, here and in production.
 */

export function runOutstationDistanceBackfillTests() {
  // --- the payload is distance and nothing else ----------------------------------------------

  const payload = buildDistanceOnlyPayload({
    distanceMeters: 120_770,
    durationInTrafficSeconds: 7_800,
    durationSeconds: 7_200,
    now: "2026-09-28T20:00:00.000Z",
    polyline: "abc123",
  });

  assert.equal(payload.distance_km, 120.77, "metres must convert to kilometres at 2 decimals");
  assert.equal(
    payload.distance_from_residence_km,
    120.77,
    "both distance columns must be written together — writing one leaves a row that shows a "
    + "distance on one surface and 'Route lookup failed' on another",
  );
  assert.equal(
    payload.duration_minutes,
    130,
    "duration must prefer the in-traffic figure, as the live calculator does",
  );
  assert.equal(payload.route_error, null, "a successful lookup must clear a stale failure note");

  // 🔴 The headline assertion: not one key of this patch may be a money column.
  const keys = Object.keys(payload);
  const moneyLeak = keys.filter((key) => (MONEY_COLUMNS as readonly string[]).includes(key));
  assert.deepEqual(
    moneyLeak,
    [],
    `the distance patch must never carry a money column — found ${moneyLeak.join(", ")}`,
  );
  const strayKeys = keys.filter((key) => !(DISTANCE_ONLY_COLUMNS as readonly string[]).includes(key));
  assert.deepEqual(strayKeys, [], `the distance patch carried a non-distance column: ${strayKeys.join(", ")}`);

  // A trip with no traffic reading still gets a duration rather than null-by-accident.
  const noTraffic = buildDistanceOnlyPayload({
    distanceMeters: 60_000,
    durationInTrafficSeconds: null,
    durationSeconds: 3_600,
    now: "2026-09-28T20:00:00.000Z",
  });
  assert.equal(noTraffic.duration_minutes, 60, "it must fall back to the plain duration");
  assert.equal(noTraffic.route_polyline, null, "a missing polyline is null, never undefined");

  // --- the two column lists cannot overlap ----------------------------------------------------

  const overlap = (DISTANCE_ONLY_COLUMNS as readonly string[]).filter((column) =>
    (MONEY_COLUMNS as readonly string[]).includes(column),
  );
  assert.deepEqual(overlap, [], `a column cannot be both writable and forbidden: ${overlap.join(", ")}`);

  // The forbidden list must actually name what prices a claim. These are the columns
  // updateManagerExpenseAsAdmin recomputes from a distance; if one is dropped from the list, this
  // guard stops guarding the thing it exists for.
  for (const column of [
    "allowance_amount",
    "claimed_total_amount",
    "expected_total_amount",
    "fuel_amount",
    "report_travel_cost",
    "ticket_amount",
  ]) {
    assert.ok(
      (MONEY_COLUMNS as readonly string[]).includes(column),
      `${column} prices the claim and must stay forbidden to the distance backfill`,
    );
  }

  // 🔴 A verdict is not currency, but it is what an approver acts on. The system flags an expense
  // and never decides one, so a backfill must not quietly upgrade "needs review" to "eligible".
  for (const column of [
    "approval_recommendation",
    "eligibility_status",
    "status",
  ]) {
    assert.ok(
      (MONEY_COLUMNS as readonly string[]).includes(column),
      `${column} is the decision an approver reads — a distance fill must never move it`,
    );
  }

  // --- the runtime guard actually throws ------------------------------------------------------

  assert.doesNotThrow(
    () => assertNoMoneyColumns(payload),
    "the real payload must pass its own guard",
  );

  assert.throws(
    () => assertNoMoneyColumns({ ...payload, fuel_amount: 0 }),
    /must never reprice a claim/,
    "a money column in the patch must throw BEFORE the write, not be silently accepted",
  );

  assert.throws(
    () => assertNoMoneyColumns({ ...payload, eligibility_status: "eligible" }),
    /must never reprice a claim/,
    "upgrading the eligibility verdict must throw too",
  );

  assert.throws(
    () => assertNoMoneyColumns({ ...payload, captured_latitude: 26.5 }),
    /not a distance column/,
    "any column outside the distance set must throw, not just the money ones",
  );

  // --- the write path is wired to the guard ---------------------------------------------------

  // Scoped to the function body, never the whole file: a file-wide search matches this change's
  // own comments and passes on prose rather than on code.
  const source = readFileSync(
    new URL("../src/lib/outstation/distance-backfill.ts", import.meta.url),
    "utf8",
  );
  const fnStart = source.indexOf("export async function recalculateOutstationDistanceOnly(");
  assert.ok(fnStart > 0, "recalculateOutstationDistanceOnly must still exist");
  const fnBody = source.slice(fnStart);

  const guardAt = fnBody.indexOf("assertNoMoneyColumns(payload)");
  const updateAt = fnBody.indexOf(".update(payload)");
  assert.ok(guardAt > 0, "the write path must call assertNoMoneyColumns");
  assert.ok(updateAt > 0, "the write path must update with the guarded payload");
  assert.ok(
    guardAt < updateAt,
    "the guard must run BEFORE the update — after it, the claim is already repriced",
  );

  assert.ok(
    fnBody.includes('.eq("status", existing.status)'),
    "the update must pin the status, so a claim approved or paid mid-flight is not written to",
  );
  assert.ok(
    fnBody.includes("getResidenceLocationForEmployee(existing.employeeHrId)"),
    "it must measure from the LIVE residence — the copy frozen on the row is the broken one",
  );
  assert.ok(
    fnBody.includes("isUnresolvedResidenceCoordinate"),
    "it must refuse an unresolved residence rather than measuring from the centroid or (0, 0)",
  );
  assert.ok(
    fnBody.includes("isOutstationExpenseInPayroll(linkedPayroll)"),
    "a request already in a payroll run keeps the distance it was paid against",
  );

  // --- the control only offers itself where the distance is missing ---------------------------

  const admin = readFileSync(
    new URL("../src/components/outstation/outstation-requests-admin.tsx", import.meta.url),
    "utf8",
  );
  assert.equal(
    admin.split("request.distanceFromResidenceKm == null ? (").length - 1,
    2,
    "Fill distance must be gated on a MISSING distance, on both the desktop table and the mobile "
    + "cards — a control on every row invites a recalculation nobody asked for",
  );
  assert.ok(
    admin.includes("recalculate-distance"),
    "the control must call the distance-only route, never the edit route",
  );
}
