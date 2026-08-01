import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { DEDUCTION_COLLECTORS, isDeductionCollectorKey } from "../src/lib/deductions/collect.ts";
import { findDayCollisions } from "../src/lib/deductions/conflict.ts";
import { clipLeaveToMonth, expandDateRange } from "../src/lib/deductions/connectors/vacation.ts";
import { buildManualDeductionDraft } from "../src/lib/deductions/connectors/manual.ts";
import { assertBaseSalaryMapLoaded, DeductionsConnectorDegradedError } from "../src/lib/deductions/connectors/health.ts";
import { isEligibleForPublish } from "../src/lib/deductions/calculations.ts";
import { chunkList, validateCandidateDraft } from "../src/lib/deductions/service.ts";
import type { DeductionsCandidateDraft } from "../src/lib/deductions/types.ts";

function draft(overrides: Partial<DeductionsCandidateDraft> = {}): DeductionsCandidateDraft {
  return {
    category: "crm",
    sourceSystem: "test",
    sourceRecordId: "rec-1",
    employeeHrId: "B-124",
    employeeName: "Test Employee",
    monthKey: "2026-06",
    month: 6,
    year: 2026,
    unit: "days",
    rawValue: 1,
    dates: ["2026-06-10"],
    ...overrides,
  };
}

export async function runDeductionsModuleSafetyTests(): Promise<void> {
  // ── PR-1.1 Pagination ────────────────────────────────────────────────────
  // WIRING assertion, not a behaviour one. The bug was never that pagination
  // was wrong — it was that it was absent while a helper for it sat in the
  // repo unused. A unit test cannot observe PostgREST's 1000-row cap, so
  // assert the source actually reaches for the helper.
  {
    const service = readFileSync("src/lib/deductions/service.ts", "utf8");
    const portal = readFileSync("src/lib/deductions/portal.ts", "utf8");
    assert.match(service, /fetchAllRows/, "service.ts must paginate reads via fetchAllRows");
    assert.match(portal, /fetchAllRows/, "portal.ts must paginate reads via fetchAllRows");
    const publish = readFileSync("src/lib/deductions/publish.ts", "utf8");
    assert.match(
      publish,
      /countCandidatesForMonth/,
      "publishMonth must verify its read against an independent count before publishing money",
    );
    assert.match(publish, /Aborting to avoid silent data loss/, "a truncated publish must abort, not proceed");
  }

  // ── PR-1.2 Null amount must never become 0 ───────────────────────────────
  {
    const publish = readFileSync("src/lib/deductions/publish.ts", "utf8");
    assert.doesNotMatch(
      publish,
      /appliedAmount \?\? candidate\.estimatedAmount \?\? 0/,
      'the "?? 0" fallback must be gone — it turned "amount unknown" into "deduct nothing"',
    );
    assert.match(
      publish,
      /have no computable amount/,
      "publish must refuse and name employees whose amount could not be computed",
    );
    // The connector that caused it must now compute an amount.
    const noRecords = readFileSync("src/lib/deductions/connectors/no-records-activity.ts", "utf8");
    assert.match(noRecords, /calculateDeductionAmountFromBaseSalary/, "no-records-activity must compute an amount");
    assert.match(
      noRecords,
      /compactDeductionsHrId/,
      "must use the COMPACT hr-id key — getBaseSalaryMap is keyed that way; the canonical key silently misses every lookup",
    );
  }

  // ── PR-1.3 Conflict detection is actually CALLED ─────────────────────────
  // The original defect: detectCrossCategoryConflict was written, documented
  // and unit-tested, but never invoked. The old tests asserted the function
  // WORKED; nothing asserted it was USED. That is the bug this guards.
  {
    const publish = readFileSync("src/lib/deductions/publish.ts", "utf8");
    const service = readFileSync("src/lib/deductions/service.ts", "utf8");
    assert.match(publish, /findDayCollisions/, "publishMonth must run the double-deduction gate");
    assert.match(service, /findDayCollisions/, "collection must surface day collisions as warnings");
  }

  // findDayCollisions behaviour: same day, two categories → collision.
  {
    const collisions = findDayCollisions([
      { employeeHrId: "B-1", employeeHrIdCompact: "b1", category: "crm", dates: ["2026-06-10"] },
      { employeeHrId: "B-1", employeeHrIdCompact: "b1", category: "fingerprint", dates: ["2026-06-10"] },
    ]);
    assert.equal(collisions.length, 1, "one employee-day claimed by two categories is a collision");
    assert.deepEqual(collisions[0].categories, ["crm", "fingerprint"]);
    assert.equal(collisions[0].date, "2026-06-10");
  }
  // Same day, same category → NOT a cross-category collision (the unique index
  // already prevents it, and double-reporting it would be noise).
  {
    const collisions = findDayCollisions([
      { employeeHrId: "B-1", employeeHrIdCompact: "b1", category: "crm", dates: ["2026-06-10"] },
      { employeeHrId: "B-1", employeeHrIdCompact: "b1", category: "crm", dates: ["2026-06-10"] },
    ]);
    assert.equal(collisions.length, 0);
  }
  // Different employees on the same day → not a collision.
  {
    const collisions = findDayCollisions([
      { employeeHrId: "B-1", employeeHrIdCompact: "b1", category: "crm", dates: ["2026-06-10"] },
      { employeeHrId: "B-2", employeeHrIdCompact: "b2", category: "fingerprint", dates: ["2026-06-10"] },
    ]);
    assert.equal(collisions.length, 0);
  }
  // Different days for the same employee → not a collision.
  {
    const collisions = findDayCollisions([
      { employeeHrId: "B-1", employeeHrIdCompact: "b1", category: "crm", dates: ["2026-06-10"] },
      { employeeHrId: "B-1", employeeHrIdCompact: "b1", category: "fingerprint", dates: ["2026-06-11"] },
    ]);
    assert.equal(collisions.length, 0);
  }

  // ── PR-1.4 Manual entry is idempotent ────────────────────────────────────
  {
    const input = {
      category: "loan" as const,
      employeeHrId: "B-124",
      month: 6,
      year: 2026,
      unit: "amount" as const,
      value: 5000,
      reason: "Staff loan repayment",
      enteredBy: "a-1",
    };
    const first = buildManualDeductionDraft(input);
    const second = buildManualDeductionDraft(input);
    assert.equal(
      first.sourceRecordId,
      second.sourceRecordId,
      "the same manual entry submitted twice must produce the SAME key so the unique index can reject the duplicate — a double-clicked 5,000 EGP loan previously became 10,000 EGP",
    );
    assert.doesNotMatch(first.sourceRecordId, /\d{13}/, "the key must not embed a timestamp");

    // A genuinely different entry must still be distinguishable.
    const differentAmount = buildManualDeductionDraft({ ...input, value: 6000 });
    assert.notEqual(first.sourceRecordId, differentAmount.sourceRecordId);
    const differentReason = buildManualDeductionDraft({ ...input, reason: "Advance against salary" });
    assert.notEqual(first.sourceRecordId, differentReason.sourceRecordId);
    // Whitespace/case differences are not a different entry.
    const noisyReason = buildManualDeductionDraft({ ...input, reason: "  Staff   Loan   Repayment " });
    assert.equal(first.sourceRecordId, noisyReason.sourceRecordId);
  }

  // ── PR-1.5 Overview and publish share ONE predicate ──────────────────────
  {
    const service = readFileSync("src/lib/deductions/service.ts", "utf8");
    assert.match(
      service,
      /isEligibleForPublish/,
      "the Overview summary must use the same eligibility predicate publish uses, or HR reads a number publish will never commit",
    );
    assert.match(service, /willPublish/, "the summary must report what will actually publish");
    assert.match(service, /pendingTotal/, "…and separately what is pending and will NOT publish");
    // The predicate itself still behaves as the owner specified.
    assert.equal(isEligibleForPublish({ category: "crm", decision: null }), true, "crm is mandatory by default");
    assert.equal(isEligibleForPublish({ category: "crm", decision: { decisionStatus: "Do Not Take Action" } }), false);
    assert.equal(
      isEligibleForPublish({ category: "crm", decision: { decisionStatus: "Disputed" } }),
      true,
      "owner rule: a dispute flags for attention but does not withhold — only the Super Admin marking it back does",
    );
    assert.equal(isEligibleForPublish({ category: "fingerprint", decision: { decisionStatus: "Pending" } }), false);
    assert.equal(
      isEligibleForPublish({ category: "fingerprint", decision: { decisionStatus: "Approved for Payroll" } }),
      true,
    );
  }

  // ── PR-1.6 Approval is not blocked by the reason rule ────────────────────
  {
    const ui = readFileSync("src/components/admin/deductions-workspace.tsx", "utf8");
    assert.doesNotMatch(
      ui,
      /status !== "Approved for Payroll" && !reason\.trim\(\)/,
      "the UI must not exempt approvals from the reason requirement — the server and a DB CHECK both require one, so every such approval failed",
    );
    assert.match(ui, /effectiveReason/, "approvals must send a prefilled default reason rather than an empty string");
  }

  // ── PR-1.7 Supersession exists ───────────────────────────────────────────
  {
    const service = readFileSync("src/lib/deductions/service.ts", "utf8");
    assert.match(service, /export async function supersedeCandidate/, "a correction path must exist");
    assert.match(service, /superseded_by_candidate_id/, "supersession must record what replaced the row");
    assert.match(
      service,
      /export async function reconcileCandidateDrafts/,
      "connectors must be able to retract candidates the source no longer supports, not only insert",
    );
    assert.match(
      service,
      /candidate\.lockedAt/,
      "a published (locked) candidate must never be auto-retracted by a re-collect",
    );
  }

  // ── PR-1.8 Cross-month vacations ─────────────────────────────────────────
  {
    assert.deepEqual(expandDateRange("2026-06-01", "2026-06-03"), ["2026-06-01", "2026-06-02", "2026-06-03"]);
    assert.deepEqual(expandDateRange("2026-06-03", "2026-06-01"), [], "an inverted range yields nothing");

    // The real bug: 25 May – 5 Jun with 11 unpaid days used to produce an
    // 11-day candidate in BOTH months = 22 days deducted for an 11-day absence.
    const may = clipLeaveToMonth({
      startDate: "2026-05-25",
      endDate: "2026-06-05",
      monthKey: "2026-05",
      totalUnpaidDays: 11,
    });
    const june = clipLeaveToMonth({
      startDate: "2026-05-25",
      endDate: "2026-06-05",
      monthKey: "2026-06",
      totalUnpaidDays: 11,
    });
    assert.ok(may.spansMonthBoundary && june.spansMonthBoundary);
    assert.equal(may.datesInMonth.length, 7, "25–31 May");
    assert.equal(june.datesInMonth.length, 5, "1–5 June");
    assert.ok(
      Math.abs(may.daysInMonth + june.daysInMonth - 11) < 0.05,
      `the two months' apportioned days must sum to the request's 11, got ${may.daysInMonth} + ${june.daysInMonth}`,
    );
    assert.ok(may.datesInMonth.every((d) => d.startsWith("2026-05-")));
    assert.ok(june.datesInMonth.every((d) => d.startsWith("2026-06-")));

    // A request wholly inside one month is untouched.
    const whole = clipLeaveToMonth({
      startDate: "2026-06-10",
      endDate: "2026-06-12",
      monthKey: "2026-06",
      totalUnpaidDays: 3,
    });
    assert.equal(whole.spansMonthBoundary, false);
    assert.equal(whole.daysInMonth, 3);
  }

  // A draft whose dates fall outside its own month is now rejected outright.
  {
    const bad = validateCandidateDraft(draft({ monthKey: "2026-06", month: 6, dates: ["2026-05-31"] }));
    assert.equal(bad.valid, false, "out-of-month dates must be rejected");
    assert.ok(bad.errors.some((e) => e.includes("must fall inside monthKey")));

    const good = validateCandidateDraft(draft({ dates: ["2026-06-10", "2026-06-11"] }));
    assert.equal(good.valid, true, `in-month dates must pass: ${good.errors.join("; ")}`);
  }

  // ── PR-1.9 Connectors fail closed ────────────────────────────────────────
  {
    assert.throws(
      () => assertBaseSalaryMapLoaded("test connector", new Map()),
      (error: unknown) => error instanceof DeductionsConnectorDegradedError,
      'an empty base-salary map must be treated as "the feeder failed", not "nobody has a salary"',
    );
    assert.doesNotThrow(() => assertBaseSalaryMapLoaded("test connector", new Map([["b1", 9000]])));

    const crm = readFileSync("src/lib/deductions/connectors/crm.ts", "utf8");
    assert.match(crm, /assertBaseSalaryMapLoaded/, "the CRM connector must fail closed on a missing salary map");
    assert.doesNotMatch(
      crm,
      /don't block candidate generation on it/,
      "the CRM anomaly guard must no longer swallow its own failure — an outage disabled the very check meant to catch it",
    );
    assert.match(
      crm,
      /if \(date > todayIso\) break;/,
      "only ELAPSED days may be seeded as zero; seeding future days would lower the median and make the detector less sensitive",
    );
  }

  // ── #1377 Collection must stay bounded per request ───────────────────────
  // The defect that got this whole module reverted: the collect route ran all
  // five company-wide scans sequentially in one HTTP request, exceeded the 300s
  // Cloud Run limit, and returned 504. Nothing about it was detectable in a unit
  // test — the failure only appears at production data volume — so these are
  // WIRING assertions that keep the shape which makes the timeout impossible.
  {
    assert.equal(DEDUCTION_COLLECTORS.length, 5, "all five automated connectors must stay registered");
    assert.deepEqual(
      DEDUCTION_COLLECTORS.map((collector) => collector.key),
      ["fingerprint", "crm", "no_records_activity", "unpaid_vacation", "insufficient_balance_vacation"],
      "connector order is the documented run order; changing it changes what an interrupted run leaves behind",
    );

    assert.equal(isDeductionCollectorKey("crm"), true);
    assert.equal(isDeductionCollectorKey("loan"), false, "manual categories are not company-wide scans");
    assert.equal(isDeductionCollectorKey(""), false);
    assert.equal(isDeductionCollectorKey(undefined), false);

    const route = readFileSync("app/api/admin/deductions/collect/route.ts", "utf8");
    assert.doesNotMatch(
      route,
      /collectAllCandidatesForMonth/,
      "the HTTP route must never run all five scans in one request — that is exactly what 504'd at 300s and caused the #1377 revert",
    );
    assert.match(route, /collectOneConnectorForMonth/, "the HTTP route must run exactly one connector per request");
    assert.match(route, /maxDuration = 300/, "the route must declare the platform timeout it is budgeting against");

    const workspace = readFileSync("src/components/admin/deductions-workspace.tsx", "utf8");
    assert.match(
      workspace,
      /connector: entry\.key/,
      "the admin UI must drive the connectors one request at a time rather than asking the server for all five",
    );
    assert.match(
      workspace,
      /AbortController/,
      "a collection request must time out client-side; the original run left the button spinning with nothing shown",
    );
  }

  // ── #1377 root cause: the write path must not be N+1 ─────────────────────
  // Bounding the request to one connector was necessary but not sufficient.
  // The actual cost driver was insertCandidateDrafts doing FOUR sequential
  // round-trips per draft (probe, insert candidate, insert decision, audit).
  // Measured against production data, July 2026 yields ~301 CRM no-activity
  // candidates alone — ~1,200 sequential queries for a single connector.
  {
    // chunkList is the correctness-critical half of the batching: a boundary
    // bug does not throw, it silently drops candidates from a payroll run.
    assert.deepEqual(chunkList([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]], "the final partial chunk must not be lost");
    assert.deepEqual(chunkList([1, 2, 3, 4], 2), [[1, 2], [3, 4]], "an exact multiple must not emit a trailing empty chunk");
    assert.deepEqual(chunkList([1], 500), [[1]], "a batch smaller than one chunk is still one chunk");
    assert.deepEqual(chunkList([], 10), [], "nothing in, nothing out — never a chunk of zero rows");
    assert.equal(
      chunkList(Array.from({ length: 301 }, (_, i) => i), 200).flat().length,
      301,
      "chunking must be lossless: every candidate that goes in must come out",
    );
    assert.deepEqual(
      chunkList(Array.from({ length: 301 }, (_, i) => i), 200).map((c) => c.length),
      [200, 101],
      "301 candidates (the measured July CRM volume) must become 2 round-trips, not 301",
    );

    const service = readFileSync("src/lib/deductions/service.ts", "utf8");
    const insertFn = service.slice(service.indexOf("export async function insertCandidateDrafts"));
    assert.doesNotMatch(
      insertFn.slice(0, insertFn.indexOf("\n}\n")),
      /for \(const draft of input\.drafts\)[\s\S]{0,2000}?await supabase[\s\S]{0,200}?\.insert\(/,
      "no per-draft insert inside the draft loop — that is the N+1 that burned the 300s budget",
    );
    assert.match(service, /CANDIDATE_PROBE_CHUNK/, "the duplicate probe must be chunked, not one query per draft");
    assert.match(service, /CANDIDATE_INSERT_CHUNK/, "candidate and decision inserts must be chunked");
    assert.match(
      service,
      /entityType: "deductions_candidate"/,
      "audit must stay ONE ROW PER CANDIDATE — this is a financial ledger; a per-batch summary would lose the trail",
    );

    // Audit writes must NOT be fanned out. Measured on production, a 25-wide
    // Promise.all silently lost 43 of 57 fingerprint audit rows — scattered at
    // random, no error surfaced, because writeAuditLog swallows its own
    // failures. An audit trail that is usually complete is not an audit trail.
    const auditSection = service.slice(service.indexOf("const auditable ="));
    assert.doesNotMatch(
      auditSection.slice(0, 1200),
      /Promise\.all/,
      "audit rows must be written sequentially — parallel fan-out silently dropped 43 of 57 rows in production",
    );
    assert.match(
      service,
      /audit trail incomplete/,
      "a short audit trail must surface as a warning, never pass silently",
    );
  }
}
