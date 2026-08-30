import assert from "node:assert/strict";

import { marketingReopenEpoch } from "../src/lib/marketing-requests/service.ts";

export function runMarketingReopenedRungRenotifyTests() {
  // THE SAFETY BRANCH. A rung that opened once must return null so its notification keeps the
  // step-id key it already used. If this ever returns a value, every pending request looks
  // un-notified at once and the backfill sweep re-notifies the whole board.
  assert.equal(marketingReopenEpoch([]), null);
  assert.equal(marketingReopenEpoch(["2026-08-30T07:19:52.097Z"]), null);

  // A REOPENED rung answers with the LATEST opening — responsibility moved back, and the approver
  // was told about the first opening only.
  assert.equal(
    marketingReopenEpoch(["2026-08-30T07:19:52.097Z", "2026-08-30T08:44:21.187Z"]),
    "2026-08-30T08:44:21.187Z",
  );

  // Production shape of MKT-REQ-20260825-AADD59CE, whose CEO rung opened at 10:19 Cairo, was
  // returned at 10:25, and was reopened at 11:44. Rows arrive in no guaranteed order.
  assert.equal(
    marketingReopenEpoch(["2026-08-30T08:44:21.187584+00:00", "2026-08-30T07:19:52.097+00:00"]),
    "2026-08-30T08:44:21.187584+00:00",
  );

  // Three openings: still the newest, never the first and never the middle.
  assert.equal(
    marketingReopenEpoch(["2026-08-01T00:00:00Z", "2026-08-30T08:44:21.187Z", "2026-08-15T12:00:00Z"]),
    "2026-08-30T08:44:21.187Z",
  );

  // Unusable rows are dropped BEFORE the count is taken, so one real opening plus noise is still a
  // rung that opened once — not a licence to re-notify.
  assert.equal(marketingReopenEpoch(["2026-08-30T07:19:52.097Z", null, undefined, "  ", "not-a-date"]), null);
  assert.equal(
    marketingReopenEpoch([null, "2026-08-30T07:19:52.097Z", "nonsense", "2026-08-30T08:44:21.187Z"]),
    "2026-08-30T08:44:21.187Z",
  );

  // The epoch is a STORED instant, not now(): the same openings must key the same notification
  // every time, or a repeated sweep would send Anwar the same notice on every run.
  const openings = ["2026-08-30T07:19:52.097Z", "2026-08-30T08:44:21.187Z"];
  assert.equal(marketingReopenEpoch(openings), marketingReopenEpoch(openings));
  assert.notEqual(marketingReopenEpoch(openings), new Date().toISOString());

  // The input is never mutated — the caller passes rows it goes on to use.
  const original = ["2026-08-30T08:44:21.187Z", "2026-08-30T07:19:52.097Z"];
  marketingReopenEpoch(original);
  assert.deepEqual(original, ["2026-08-30T08:44:21.187Z", "2026-08-30T07:19:52.097Z"]);
}
