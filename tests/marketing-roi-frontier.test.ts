import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { lastFinishedCairoMonth, pickLoadedFrontier } from "../src/lib/marketing-requests/roi-frontier.ts";

/**
 * 🔴 "Validated sales through Nov 2026" on 26 Oct 2026. The direct-orders feed writes one validated
 * batch per month, dated by the ORDER; two of them (Oct, and a Nov order created 14 Oct) were the only
 * batches in their months, which emptied the every-month set and walked the frontier to a month that
 * had not happened. One EGP 1,000 campaign was then judged BEHIND at 100% confidence.
 */
export function runMarketingRoiFrontierTests() {
  const file = (period: string, distributor_code: string) => ({ period, distributor_code, template_key: "distributor_sales" });
  const directOrders = (period: string) => ({ period, distributor_code: "DirectReq", template_key: "direct_orders" });

  // The real shape: EP and MC file every month; DirectReq alone holds Oct and Nov.
  const live = [
    file("2026-08", "EP"), file("2026-08", "MC"), file("2026-08", "KAS"), directOrders("2026-08"),
    file("2026-09", "EP"), file("2026-09", "KAS"), directOrders("2026-09"),
    directOrders("2026-10"), directOrders("2026-11"),
  ];
  assert.equal(
    pickLoadedFrontier(live, "2026-09"),
    "2026-08",
    "a month holding only the direct-orders feed is not loaded, and September lacks MC",
  );
  assert.equal(
    pickLoadedFrontier([...live, file("2026-09", "MC")], "2026-09"),
    "2026-09",
    "once the every-month distributors file September it is the frontier",
  );
  assert.equal(
    pickLoadedFrontier([directOrders("2026-10"), directOrders("2026-11")], "2026-10"),
    null,
    "direct orders alone never make anything loaded",
  );
  // Direct orders are recognised by either marker — a renamed template must not bring the bug back.
  assert.equal(
    pickLoadedFrontier([file("2026-08", "EP"), { period: "2026-10", distributor_code: "DIRECTREQ", template_key: null }], "2026-10"),
    "2026-08",
    "the DirectReq distributor code alone is enough to be ignored",
  );
  // The ceiling: even a real distributor file dated in the future cannot move the frontier there.
  assert.equal(
    pickLoadedFrontier([file("2026-08", "EP"), file("2026-09", "EP"), file("2026-11", "EP")], "2026-10"),
    "2026-09",
    "nothing later than the last finished month is ever returned",
  );

  assert.equal(lastFinishedCairoMonth(new Date("2026-10-26T10:00:00Z")), "2026-09", "26 Oct → September");
  assert.equal(lastFinishedCairoMonth(new Date("2027-01-15T10:00:00Z")), "2026-12", "January looks back to the previous December");
  // Cairo is UTC+2/+3: 23:30 UTC on 30 Sep is already 1 Oct in Cairo, so September has finished.
  assert.equal(lastFinishedCairoMonth(new Date("2026-09-30T23:30:00Z")), "2026-09", "the month turns on the Cairo clock, not UTC");

  // The SQL helper says the same thing, so the two cannot drift.
  const migration = readFileSync("supabase/migrations/20261026150001_roi_frontier_ignores_direct_orders_and_the_future.sql", "utf8");
  assert.match(migration, /<>\s*'direct_orders'/, "the migration skips the direct-orders template");
  assert.match(migration, /<>\s*'DIRECTREQ'/, "and the DirectReq distributor");
  assert.match(migration, /Africa\/Cairo/, "and caps at the last finished month in Cairo");
  assert.match(migration, /statement_timeout/, "keeping the statement timeout the guardrail test pins");
}
