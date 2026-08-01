import assert from "node:assert/strict";

import {
  buildSosCoverageReport,
  describeSosCoverageGaps,
  enumeratePeriods,
  type SosCoverageBatch,
} from "../src/lib/sales/sos-coverage.ts";

// Nothing in the SoS pipeline noticed a month that was never uploaded. Production on 2026-07-31 had
// batches for 2026-01/02/03/04/06 — 2026-05 simply absent — and every trend line drew straight
// through the gap. Per-distributor gaps are subtler and cost more: January is missing EP-BK and
// EP-PHS entirely, so "January vs February" partly measures which files were uploaded.

const b = (period: string, distributorCode: string, totalValue: number): SosCoverageBatch => ({
  period,
  distributorCode,
  totalValue,
});

export function runSosDataCoverageTests() {
  // ── enumeratePeriods ────────────────────────────────────────────────────────
  assert.deepEqual(enumeratePeriods("2026-01", "2026-04"), ["2026-01", "2026-02", "2026-03", "2026-04"]);
  assert.deepEqual(enumeratePeriods("2025-11", "2026-02"), ["2025-11", "2025-12", "2026-01", "2026-02"], "crosses the year boundary");
  assert.deepEqual(enumeratePeriods("2026-03", "2026-03"), ["2026-03"], "single month");
  assert.deepEqual(enumeratePeriods("2026-05", "2026-01"), [], "reversed range yields nothing rather than looping");
  assert.deepEqual(enumeratePeriods("nonsense", "2026-01"), [], "malformed input fails safe");
  assert.deepEqual(enumeratePeriods("2026-13", "2026-14"), [], "month 13 is not a month");

  // ── Nothing loaded ──────────────────────────────────────────────────────────
  {
    const report = buildSosCoverageReport([]);
    assert.equal(report.hasGaps, false, "no data is not the same as a gap");
    assert.deepEqual(report.loadedPeriods, []);
    assert.equal(describeSosCoverageGaps(report), null);
  }

  // ── A fully complete window reports no gaps ────────────────────────────────
  {
    const report = buildSosCoverageReport([
      b("2026-01", "PS", 100), b("2026-01", "IS", 50),
      b("2026-02", "PS", 110), b("2026-02", "IS", 55),
    ]);
    assert.equal(report.hasGaps, false);
    assert.deepEqual(report.missingPeriods, []);
    assert.deepEqual(report.distributors, [], "no distributor has a gap");
    assert.equal(report.periods.every((p) => !p.incomplete), true);
    assert.equal(describeSosCoverageGaps(report), null);
  }

  // ── The real production shape: 2026-05 missing entirely ────────────────────
  {
    const report = buildSosCoverageReport([
      b("2026-01", "PS", 100), b("2026-02", "PS", 100), b("2026-03", "PS", 100),
      b("2026-04", "PS", 100), b("2026-06", "PS", 100),
    ]);
    assert.deepEqual(report.loadedPeriods, ["2026-01", "2026-02", "2026-03", "2026-04", "2026-06"]);
    assert.deepEqual(report.missingPeriods, ["2026-05"], "a month with no batches at all must be named");
    assert.equal(report.hasGaps, true);
    assert.match(describeSosCoverageGaps(report) ?? "", /2026-05 was never uploaded/);
  }

  // ── A distributor missing from one month, with the value it implies ────────
  {
    // EP-BK present in Feb/Mar/Jun but absent from Jan — the real January case.
    const report = buildSosCoverageReport([
      b("2026-01", "PS", 1000),
      b("2026-02", "PS", 1000), b("2026-02", "EP-BK", 200),
      b("2026-03", "PS", 1000), b("2026-03", "EP-BK", 400),
    ]);
    // This is the real January EP-BK case. The whole SoS history was backfilled over three days, so
    // "never uploaded for January" and "onboarded in February" are indistinguishable from the batch
    // table alone — and the costly one is the former (~3.5M EGP). The gap IS reported, with
    // firstSeen so a genuine onboarding stays explainable.
    const epbk = report.distributors.find((d) => d.distributorCode === "EP-BK");
    assert.ok(epbk, "a distributor absent from a loaded month must be reported");
    assert.deepEqual(epbk.missingPeriods, ["2026-01"], "January is reported even though Feb is its first month");
    assert.equal(epbk.firstSeen, "2026-02", "firstSeen lets the UI distinguish onboarding from a hole");
    assert.deepEqual(epbk.interiorMissingPeriods, [], "a leading gap is not an interior one");
    assert.equal(report.hasGaps, true);

    // Now it IS first seen in January, so the later gap is real.
    const report2 = buildSosCoverageReport([
      b("2026-01", "PS", 1000), b("2026-01", "EP-BK", 300),
      b("2026-02", "PS", 1000),
      b("2026-03", "PS", 1000), b("2026-03", "EP-BK", 500),
    ]);
    const epbk2 = report2.distributors.find((d) => d.distributorCode === "EP-BK");
    assert.ok(epbk2, "EP-BK must be reported");
    assert.deepEqual(epbk2.missingPeriods, ["2026-02"]);
    assert.deepEqual(
      epbk2.interiorMissingPeriods,
      ["2026-02"],
      "present in Jan and Mar, absent in Feb — no onboarding story can explain this one",
    );
    assert.equal(epbk2.averageValue, 400, "mean of the months it DID land in (300, 500)");
    assert.equal(epbk2.estimatedMissingValue, 400, "one missing month x the mean");

    const feb = report2.periods.find((p) => p.period === "2026-02");
    assert.ok(feb, "February must be reported");
    assert.equal(feb.incomplete, true, "a month missing a known distributor is not like-for-like");
    assert.deepEqual(feb.missingDistributors, ["EP-BK"]);

    const jan = report2.periods.find((p) => p.period === "2026-01");
    assert.equal(jan?.incomplete, false, "a complete month is not flagged");
    assert.equal(jan?.distributorCount, 2);
    assert.equal(jan?.totalValue, 1300);
  }

  // ── A distributor first seen mid-window is reported, but marked as such ────
  {
    const report = buildSosCoverageReport([
      b("2026-01", "PS", 100),
      b("2026-02", "PS", 100),
      b("2026-03", "PS", 100), b("2026-03", "NEW", 10),
    ]);
    const fresh = report.distributors.find((d) => d.distributorCode === "NEW");
    assert.ok(fresh, "reported, because 'never uploaded' and 'newly onboarded' look identical here");
    assert.deepEqual(fresh.missingPeriods, ["2026-01", "2026-02"]);
    assert.deepEqual(fresh.interiorMissingPeriods, [], "but flagged as leading, not an interior hole");
    assert.equal(fresh.firstSeen, "2026-03");
  }

  // ── Multiple batches for one distributor in a month are summed, not doubled ─
  {
    const report = buildSosCoverageReport([b("2026-01", "PS", 100), b("2026-01", "PS", 50)]);
    const jan = report.periods[0];
    assert.equal(jan.distributorCount, 1, "one distributor, however many batches");
    assert.equal(jan.totalValue, 150);
  }

  // ── Gaps are ranked by the value they hide ─────────────────────────────────
  {
    const report = buildSosCoverageReport([
      b("2026-01", "BIG", 10_000), b("2026-01", "SMALL", 10),
      b("2026-02", "PS", 1),
      b("2026-03", "BIG", 10_000), b("2026-03", "SMALL", 10), b("2026-03", "PS", 1),
    ]);
    assert.equal(report.distributors[0].distributorCode, "BIG", "the costliest gap is reported first");
    assert.match(describeSosCoverageGaps(report) ?? "", /BIG is missing from 2026-02/);
    assert.match(describeSosCoverageGaps(report) ?? "", /not like-for-like/);
  }

  // ── Malformed rows are ignored rather than corrupting the report ───────────
  {
    const report = buildSosCoverageReport([
      b("2026-01", "PS", 100),
      { period: "", distributorCode: "PS", totalValue: 5 },
      { period: "2026-02", distributorCode: "   ", totalValue: 5 },
      { period: "2026-1", distributorCode: "PS", totalValue: 5 },
    ]);
    assert.deepEqual(report.loadedPeriods, ["2026-01"], "only well-formed periods count");
  }
}
