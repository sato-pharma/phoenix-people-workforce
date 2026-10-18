import assert from "node:assert/strict";

import {
  decideVerdict,
  grewOver,
  monthLabel,
  requestSignal,
  type RequestEvidence,
  type VisitEvidence,
} from "../src/lib/customer-360/verdict.ts";

/**
 * Whitelist · Watch · Blacklist — the owner's rule (2026-10-18). Whitelist when sales grow after the
 * marketing request "even a little bit" (10× not required), or start from nothing, or the pharmacies
 * tied through visits start selling. Blacklist only when the ROI window has CLOSED under 10× AND the
 * pharmacies stayed flat. An open window never makes a Blacklist.
 */

const CLOSED = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"];

function monthly(values: Record<string, number>): Map<string, number> {
  return new Map(Object.entries(values));
}

function request(overrides: Partial<RequestEvidence> = {}): RequestEvidence {
  return {
    actualRoi: 0,
    committed: true,
    cost: 10_000,
    payMonth: "2026-06",
    requestCode: "MR-0001",
    requestId: "r-1",
    requiredRoi: 100_000,
    roiResult: "behind",
    salesByMonth: new Map(),
    windowClosed: true,
    ...overrides,
  };
}

const FLAT = monthly({ "2026-03": 1000, "2026-04": 1000, "2026-05": 1000, "2026-07": 1000, "2026-08": 1000, "2026-09": 1000 });
const GREW_A_LITTLE = monthly({ "2026-03": 1000, "2026-04": 1000, "2026-05": 1000, "2026-07": 1100, "2026-08": 1100, "2026-09": 1100 });

function visits(overrides: Partial<VisitEvidence> = {}): VisitEvidence {
  return { salesByMonth: new Map(), visitedMonths: new Set(["2026-08"]), ...overrides };
}

export function runCustomer360VerdictTests() {
  // ── Growth, the owner's whitelist ─────────────────────────────────────────────────────────────
  assert.equal(grewOver(1000, 1001), true, "growing even a little is growth");
  assert.equal(grewOver(1000, 1000), false, "the same is not growth");
  assert.equal(grewOver(0, 1), true, "nothing before and something after is growth");
  assert.equal(grewOver(0, 0), false, "nothing on both sides is not");

  const littleGrowth = decideVerdict({ closedMonths: CLOSED, hasSalesCode: true, requests: [request({ salesByMonth: GREW_A_LITTLE })], visits: null });
  assert.equal(littleGrowth.verdict, "whitelist", "growth after the request whitelists even with the 10× missed and the window closed");
  assert.match(littleGrowth.reasons.join(" "), /rose from 1,000 EGP to 1,100 EGP/, "and the reason says by how much, in plain words");

  const fromNothing = decideVerdict({
    closedMonths: CLOSED,
    hasSalesCode: true,
    requests: [request({ salesByMonth: monthly({ "2026-08": 500 }) })],
    visits: null,
  });
  assert.equal(fromNothing.verdict, "whitelist", "no sales before and sales after whitelists");
  assert.match(fromNothing.reasons.join(" "), /had no sales before/);

  const metButFell = decideVerdict({
    closedMonths: CLOSED,
    hasSalesCode: true,
    requests: [request({ actualRoi: 120_000, roiResult: "on_track", salesByMonth: monthly({ "2026-05": 900, "2026-07": 500 }) })],
    visits: null,
  });
  assert.equal(metButFell.verdict, "whitelist", "a request that met its 10× is money that came back");

  const early = decideVerdict({
    closedMonths: CLOSED,
    hasSalesCode: true,
    requests: [request({ payMonth: "2026-08", salesByMonth: monthly({ "2026-07": 100, "2026-09": 300 }), windowClosed: false })],
    visits: null,
  });
  assert.equal(early.verdict, "whitelist");
  assert.equal(early.early, true, "a whitelist on one closed month after the request is said to be early");
  assert.match(early.reasons.join(" "), /Early/);

  // ── Blacklist: window closed under 10× AND flat ───────────────────────────────────────────────
  const flatClosed = decideVerdict({ closedMonths: CLOSED, hasSalesCode: true, requests: [request({ salesByMonth: FLAT })], visits: null });
  assert.equal(flatClosed.verdict, "blacklist", "ROI missed with the window closed and the pharmacies flat is a blacklist");
  assert.match(flatClosed.reasons.join(" "), /window has closed/);

  const flatOpen = decideVerdict({
    closedMonths: CLOSED,
    hasSalesCode: true,
    requests: [request({ roiResult: "awaiting_data", salesByMonth: FLAT, windowClosed: false })],
    visits: null,
  });
  assert.equal(flatOpen.verdict, "watch", "a request still waiting for its window never makes a blacklist");

  const uncommitted = decideVerdict({
    closedMonths: CLOSED,
    hasSalesCode: true,
    requests: [request({ committed: false, salesByMonth: FLAT })],
    visits: null,
  });
  assert.notEqual(uncommitted.verdict, "blacklist", "a request whose money was never committed decides nothing");
  assert.notEqual(uncommitted.verdict, "whitelist");

  const notYet = decideVerdict({
    closedMonths: CLOSED,
    hasSalesCode: true,
    requests: [request({ payMonth: "2026-09", salesByMonth: FLAT, windowClosed: false })],
    visits: null,
  });
  assert.equal(notYet.verdict, "watch", "money paid in the last closed month waits to be judged");
  assert.match(notYet.reasons.join(" "), /no closed month after it yet/);

  // ── Nothing to measure ────────────────────────────────────────────────────────────────────────
  const noCode = decideVerdict({ closedMonths: CLOSED, hasSalesCode: false, requests: [request({ salesByMonth: GREW_A_LITTLE })], visits: null });
  assert.equal(noCode.verdict, "not_enough_data", "without a pharmacy the closing can find, nothing is judged — whatever was spent");

  // ── The visit signal ──────────────────────────────────────────────────────────────────────────
  const startedSelling = decideVerdict({
    closedMonths: CLOSED,
    hasSalesCode: true,
    requests: [],
    visits: visits({ salesByMonth: monthly({ "2026-08": 400 }) }),
  });
  assert.equal(startedSelling.verdict, "whitelist", "pharmacies tied through his visits that start selling whitelist him");

  const notVisited = decideVerdict({
    closedMonths: CLOSED,
    hasSalesCode: true,
    requests: [],
    visits: visits({ salesByMonth: monthly({ "2026-08": 400 }), visitedMonths: new Set(["2026-02"]) }),
  });
  assert.equal(notVisited.verdict, "not_enough_data", "a rise is credited to the visits only when he was visited in that span");

  const visitedFlat = decideVerdict({
    closedMonths: CLOSED,
    hasSalesCode: true,
    requests: [],
    visits: visits({ salesByMonth: monthly({ "2026-04": 500, "2026-05": 500, "2026-06": 500, "2026-07": 500, "2026-08": 500, "2026-09": 500 }) }),
  });
  assert.equal(visitedFlat.verdict, "watch", "visited and flat is a watch, never a blacklist on visits alone");

  const silent = decideVerdict({ closedMonths: CLOSED, hasSalesCode: true, requests: [], visits: visits() });
  assert.equal(silent.verdict, "not_enough_data", "nothing sold on either side is nothing to judge, not a flat line");

  // ── Closed months only ────────────────────────────────────────────────────────────────────────
  const withRunningMonth = request({ salesByMonth: monthly({ "2026-05": 1000, "2026-07": 1000, "2026-10": 900_000 }) });
  const signal = requestSignal(withRunningMonth, CLOSED);
  assert.equal(signal.after, (1000 + 0 + 0) / 3, "the running month's sales never reach the after average");
  const before = requestSignal(request({ payMonth: "2026-07", salesByMonth: monthly({ "2026-01": 99_000, "2026-06": 300 }) }), CLOSED);
  assert.equal(before.before, 100, "before is the three closed months before the pay month, never older ones");

  assert.equal(monthLabel("2026-09"), "September 2026", "months are said as words");
}
