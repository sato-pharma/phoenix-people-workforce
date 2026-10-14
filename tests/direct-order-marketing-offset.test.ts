import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { deriveDirectOrderCollection } from "../src/lib/direct-orders/collection-rules.ts";
import {
  deriveOutstandingAmount,
  deriveRemainingWhenCollectionCleared,
  isMissingOffsetTableError,
  offsetErrorMessage,
  validateOffset,
} from "../src/lib/direct-orders/offset-rules.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Settling a marketing request against a direct order's debt (Zamzam Hospital, October 2026).
 *
 * The case that shaped it: a 504-box order worth 133,056 EGP was paid net — 108,056 in cash, and
 * 25,000 that the hospital kept as the fee of a service owed to its own doctor. That 25,000 is
 * neither collected nor paid out; it is a request settled by the order's debt.
 *
 * Properties held here:
 *   1. The debt is value - cash - offsets, so the Zamzam order reads zero outstanding.
 *   2. An offset can never overshoot the order or the request, and a request settles once.
 *   3. Recording or clearing a COLLECTION keeps the offsets - it must not put settled debt back.
 *   4. An offset is not a collection: the service never writes cash columns, and the database
 *      function that does the write is locked down to the service role.
 */

const read = (path: string) => stripComments(readFileSync(new URL(path, import.meta.url), "utf8"));

export async function runDirectOrderMarketingOffsetTests() {
  // ── 1. The Zamzam numbers ──────────────────────────────────────────────────
  assert.equal(
    deriveOutstandingAmount({ offsetTotal: 0, paidAmount: 108056, salesValue: 133056 }),
    25000,
    "before the settlement the order owes the 25,000 the hospital kept",
  );
  assert.equal(
    deriveOutstandingAmount({ offsetTotal: 25000, paidAmount: 108056, salesValue: 133056 }),
    0,
    "after it, nothing is owed - and no cash moved",
  );
  assert.equal(
    deriveOutstandingAmount({ offsetTotal: 25000, paidAmount: null, salesValue: 133056 }),
    108056,
    "an order with no collection recorded still nets the offset",
  );
  assert.equal(
    deriveOutstandingAmount({ offsetTotal: 200, paidAmount: 100, salesValue: 250 }),
    0,
    "never a negative debt on a Finance screen",
  );

  // ── 2. Who and what may be settled ─────────────────────────────────────────
  const ok = {
    amount: 25000,
    orderStatus: "approved",
    outstanding: 25000,
    requestAlreadySettled: false,
    requestCost: 25000,
    requestStatus: "active",
  };
  assert.deepEqual(validateOffset(ok), { ok: true, amount: 25000 });
  assert.equal(validateOffset({ ...ok, orderStatus: "pending_approval" }).ok, false, "only an approved order has a debt");
  assert.equal(validateOffset({ ...ok, requestStatus: "pending_approval" }).ok, false, "an unapproved request is not settled yet");
  assert.equal(validateOffset({ ...ok, requestStatus: "rejected" }).ok, false, "a rejected request is never settled");
  assert.equal(validateOffset({ ...ok, requestAlreadySettled: true }).ok, false, "a request settles once");
  assert.equal(validateOffset({ ...ok, amount: 25000.01, outstanding: 30000 }).ok, false, "never more than the request is worth");
  assert.equal(validateOffset({ ...ok, outstanding: 24999.99 }).ok, false, "never more than the order still owes");
  assert.equal(validateOffset({ ...ok, amount: 0 }).ok, false, "zero is not a settlement");
  assert.equal(validateOffset({ ...ok, amount: null }).ok, false, "blank is not a settlement");
  assert.deepEqual(validateOffset({ ...ok, amount: 10000, requestCost: 25000 }), { ok: true, amount: 10000 }, "part of a request may be settled");

  // ── 3. A collection keeps the offsets ──────────────────────────────────────
  const collection = (paidAmount: number, offsetTotal?: number) =>
    deriveDirectOrderCollection({
      offsetTotal,
      paidAmount,
      paymentDate: "2026-10-14",
      salesValue: 133056,
      status: "approved",
      todayCairo: "2026-10-15",
    });
  const withoutOffset = collection(108056);
  assert.equal(withoutOffset.ok && withoutOffset.remainingAmount, 25000, "no offsets: the remainder is exactly what it always was");
  const withOffset = collection(108056, 25000);
  assert.equal(withOffset.ok && withOffset.remainingAmount, 0, "a later collection edit must not put the settled 25,000 back");
  assert.equal(collection(120000, 25000).ok, false, "cash plus offsets can never pass the order's value");
  const refused = collection(120000, 25000);
  assert.ok(!refused.ok && refused.message.includes("108,056.00 EGP"), "the refusal names the most that can still be collected");
  assert.equal(
    deriveRemainingWhenCollectionCleared({ offsetTotal: 0, salesValue: 133056 }),
    null,
    "clearing with no offsets restores the untouched null",
  );
  assert.equal(
    deriveRemainingWhenCollectionCleared({ offsetTotal: 25000, salesValue: 133056 }),
    108056,
    "clearing the cash leaves the settled amount settled",
  );

  // ── 4. Words, and a table that is not there yet ────────────────────────────
  assert.equal(
    offsetErrorMessage(new Error("offset_exceeds_outstanding")),
    "The order does not have that much still outstanding.",
  );
  assert.equal(offsetErrorMessage({ message: "something else entirely" }), null, "an error that is not ours is left alone");
  assert.equal(isMissingOffsetTableError({ code: "PGRST205", message: "x" }), true, "a missing table answers PGRST205");
  assert.equal(isMissingOffsetTableError({ code: "23505", message: "duplicate key" }), false);

  // ── 5. The write path ──────────────────────────────────────────────────────
  const migration = read("../supabase/migrations/20261015012551_direct_order_marketing_offsets.sql");
  assert.ok(migration.includes("enable row level security"), "RLS is on");
  assert.ok(migration.includes("direct_order_marketing_offsets_request_key unique (marketing_request_id)"), "a request settles once");
  for (const fn of [
    "phx_record_direct_order_offset(uuid, uuid, numeric, text, text)",
    "phx_remove_direct_order_offset(uuid, text)",
  ]) {
    assert.ok(
      migration.includes(`revoke execute on function public.${fn} from public, anon, authenticated;`),
      `${fn} is closed to the browser roles`,
    );
    assert.ok(migration.includes(`grant execute on function public.${fn} to service_role;`), `${fn} is open to the service role`);
  }
  assert.ok(migration.includes("for update"), "both parents are locked before the balance is checked");

  const service = read("../src/lib/direct-orders/marketing-offset-service.ts");
  assert.ok(
    (service.match(/assertCanSettle\(access\)/g) ?? []).length === 3,
    "the three entry points that take an access context (list, record, remove) each check Finance's authority",
  );
  assert.ok(service.includes("canRecordDirectOrderCollection"), "settling follows the same authority as recording a collection");
  assert.ok(!service.includes("payment_date"), "an offset is not a collection: it never stamps a payment date");
  assert.ok(!service.includes(".update("), "the order's remainder is rewritten by the locked database function, never from here");

  const route = read("../app/api/marketing-requests/direct-order-offset/route.ts");
  assert.equal((route.match(/assertSameOriginMutation\(request\)/g) ?? []).length, 2, "POST and DELETE both check the origin");

  const registry = read("../src/lib/security/access-registry.ts");
  assert.ok(registry.includes('pattern: "/api/marketing-requests/direct-order-offset"'), "the route is declared in the access registry");
}
