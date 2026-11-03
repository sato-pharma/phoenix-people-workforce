import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { DEDUCTION_COLLECTORS, isDeductionCollectorKey } from "../src/lib/deductions/collect.ts";
import { findDayCollisions } from "../src/lib/deductions/conflict.ts";
import { clipLeaveToMonth, expandDateRange } from "../src/lib/deductions/connectors/vacation.ts";
import { buildManualDeductionDraft } from "../src/lib/deductions/connectors/manual.ts";
import { assertBaseSalaryMapLoaded, DeductionsConnectorDegradedError } from "../src/lib/deductions/connectors/health.ts";
import { isEligibleForPublish } from "../src/lib/deductions/calculations.ts";
import { chunkList, validateCandidateDraft } from "../src/lib/deductions/service.ts";
import { deductionsCategories, visibleDeductionsCategories, type DeductionsCandidateDraft } from "../src/lib/deductions/types.ts";

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
  // ── Display names on screens and emails, legal names on what feeds payroll (owner, 2026-11-03) ──
  // publish.ts and push.ts STAMP candidate.employeeName onto the publication line, and the two
  // workbooks feed payroll, so listCandidatesForMonth must stay opt-in: only a screen asks.
  {
    const service = readFileSync("src/lib/deductions/service.ts", "utf8");
    assert.match(
      service,
      /\(input\.showDisplayNames \? known\?\.shownName : null\) \|\| storedName/,
      "the display name wins only when the caller asked for it",
    );
    assert.match(
      readFileSync("app/api/admin/deductions/candidates/route.ts", "utf8"),
      /listCandidatesForMonth\(\{ monthKey, category, showDisplayNames: true \}\)/,
      "the workspace is a screen, so it asks for the display name",
    );
    for (const file of [
      "src/lib/deductions/publish.ts",
      "src/lib/deductions/push.ts",
      "src/lib/automated-payroll/deductions-source.ts",
      "app/api/admin/deductions/export/route.ts",
      "app/api/admin/deductions/export/master/route.ts",
    ]) {
      assert.ok(
        !readFileSync(file, "utf8").includes("showDisplayNames"),
        `${file} stamps a row or feeds payroll, so it must keep the name as stored`,
      );
    }
    for (const file of [
      "src/lib/deductions/comments.ts",
      "src/lib/deductions/portal.ts",
      "src/lib/dispute-center/events.ts",
    ]) {
      const source = readFileSync(file, "utf8");
      assert.ok(source.includes("namesByHrId("), `${file} must resolve people through the shared display-name read`);
      assert.ok(!/select\("[^"]*full_name/.test(source), `${file} must not read full_name to print a person`);
    }
    assert.match(
      readFileSync("src/lib/dispute-center/deduction.ts", "utf8"),
      /nameFor\(input\.names, input\.candidate\.employee_hr_id\) \?\?\s+input\.candidate\.employee_name/,
      "a dispute shows the employee's display name first, and the stored name only as the fallback",
    );
    // Both attendance reports print the display name now, so what they hand a deduction line is a
    // separate field. Reading `employeeName` there writes a nickname onto a payroll record.
    assert.match(
      readFileSync("src/lib/deductions/connectors/fingerprint.ts", "utf8"),
      /employeeName: row\.employeeFullName \|\| row\.employeeName \|\| null,/,
      "the monthly fingerprint connector stamps the full name",
    );
    assert.match(
      readFileSync("src/lib/attendance/employee-day-report.ts", "utf8"),
      /employeeName: dayReport\.employeeFullName,/,
      "the day report's deduction line stamps the full name",
    );
    assert.match(
      readFileSync("src/lib/deductions/connectors/crm.ts", "utf8"),
      /employeeName: fullNameByHrIdKey\.get\(key\) \|\| recommendation\.employeeName,/,
      "a CRM deduction stamps the full name by HR id, because the report it comes from prints the display name",
    );
    assert.match(
      readFileSync("src/lib/private-calendar/service.ts", "utf8"),
      /employeeName: fullNameByHrId\.get\(exception\.employeeHrId as string\) \|\|/,
      "a No Records deduction, monthly or daily, stamps the full name",
    );
    assert.match(
      readFileSync("src/lib/hr-ops-reports/bridge.ts", "utf8"),
      /const fullName = await loadFullNameForDeduction\(draft\.employeeHrId\);/,
      "a reviewed field day stamps the full name, whatever the report row prints",
    );
    assert.match(
      readFileSync("src/lib/hr-ops-reports/office-section.ts", "utf8"),
      /employeeName: input\.employee\.employeeFullName \|\| input\.employee\.employeeName,/,
      "a Head Office report row stores the full name and prints the current name at read",
    );
    assert.match(
      readFileSync("src/lib/vacation/service.ts", "utf8"),
      /manager_name: approver\.fullName,/,
      "a reassigned vacation request stores the approver's full name",
    );
  }

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
    // Was 5, then 4: no_records_activity was retired once its connector lost its
    // population — field workforce belongs to `crm`, Head Office has no CRM
    // obligation, and between them that is everybody — so a registered step would
    // report created=0 forever and be indistinguishable from a broken connector.
    // holiday_bridge was then added, taking it back to 5, dsm_no_record to 6, and
    // crm_half_day (owner, 2026-10-08) to 7. The exact keys are pinned just below.
    assert.equal(DEDUCTION_COLLECTORS.length, 7, "the seven live automated connectors must stay registered");
    assert.deepEqual(
      DEDUCTION_COLLECTORS.map((collector) => collector.key),
      [
        "fingerprint",
        "crm",
        "unpaid_vacation",
        "insufficient_balance_vacation",
        "dsm_no_record",
        "crm_half_day",
        "holiday_bridge",
      ],
      "connector order is the documented run order; changing it changes what an interrupted run leaves behind",
    );
    // Both ledger-reading connectors must follow the four that own their own
    // populations. Either one running earlier would dedup against an incomplete
    // ledger and manufacture the same-day duplicates the owner's rule forbids.
    {
      const order = DEDUCTION_COLLECTORS.map((collector) => collector.key);
      assert.ok(
        order.indexOf("dsm_no_record") > order.indexOf("crm"),
        "dsm_no_record must run after crm — it skips days the rep pipeline already charged",
      );
      assert.ok(
        order.indexOf("holiday_bridge") > order.indexOf("dsm_no_record"),
        "holiday_bridge must run after dsm_no_record for the same reason",
      );
      // The half-day scan reports a date another category already charges instead of raising it,
      // so it must see every full-day finding first — and holiday_bridge must see the half days.
      assert.ok(
        order.indexOf("crm_half_day") > order.indexOf("dsm_no_record"),
        "crm_half_day must run after every full-day connector — it skips days they already charge",
      );
      assert.ok(
        order.indexOf("holiday_bridge") > order.indexOf("crm_half_day"),
        "holiday_bridge must run after crm_half_day so a half-day date is never charged twice",
      );
    }
    assert.equal(
      DEDUCTION_COLLECTORS[DEDUCTION_COLLECTORS.length - 1]?.key,
      "holiday_bridge",
      "holiday_bridge must run LAST — its dedup reads the live ledger to skip days another category already charges, so running it earlier would find an empty ledger and manufacture the duplicates the rule forbids",
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
    // Chunked by URL BYTES, not row count. candidate_key length varies hugely by
    // category (production: fingerprint ~69 chars, crm avg 145 / max 367), so a
    // flat 200-row chunk built a ~73 KB `in.()` URL and died as
    // "TypeError: fetch failed" — which failed the run closed and collected 0.
    assert.match(service, /PROBE_URL_BUDGET_CHARS/, "the duplicate probe must be chunked by URL bytes, not row count");
    assert.match(
      service,
      /chunkByEncodedLength\(deduped/,
      "the probe must size its chunks from the encoded key length",
    );
    assert.match(
      service,
      /const mid = Math\.ceil\(chunk\.length \/ 2\)/,
      "a failed probe chunk must split and retry, so no future key length can break collection again",
    );
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
    // Bound the audit section by the END OF ITS FUNCTION, not by 1200 bytes. The loop it is
    // guarding already runs to ~1000 bytes, so two more lines would have pushed the fan-out this
    // forbids past the cut — and a `doesNotMatch` that cannot see the code PASSES.
    const auditStart = service.indexOf("const auditable =");
    const auditEnd = service.slice(auditStart).search(/^\}$/m);
    const auditSection = service.slice(auditStart, auditEnd >= 0 ? auditStart + auditEnd : service.length);
    assert.doesNotMatch(
      auditSection,
      /Promise\.all/,
      "audit rows must be written sequentially — parallel fan-out silently dropped 43 of 57 rows in production",
    );
    assert.match(
      service,
      /audit trail incomplete/,
      "a short audit trail must surface as a warning, never pass silently",
    );
  }

  // ── Zero CRM signal is a data gap, not a field-activity failure ──────────
  // no-records-activity.ts already states the rule ("zero possible positive
  // signal ... just noise from a data-mapping gap"), but its guard only tests
  // `crm_id IS NULL` — so it caught the unmapped case and missed the
  // mapped-but-never-used one. Measured on July 2026 production data that miss
  // charged two Head Office managers for essentially their whole month:
  // A-9 20 days / 30,967.74 EGP and A-8 16 days / 22,193.55 EGP, both with ZERO
  // CRM rows while punching in 36 and 13 times. B-155, with 44 CRM rows the
  // same month, is correctly still in scope.
  {
    const crm = readFileSync("src/lib/deductions/connectors/crm.ts", "utf8");
    assert.match(
      crm,
      /async function loadZeroCrmSignalHrIdKeys/,
      "the CRM connector must exclude employees with no CRM signal at all for the period",
    );
    assert.match(
      crm,
      /zeroCrmSignalKeys\.has\(key\)\) continue/,
      "the zero-signal set must actually skip the recommendation, not just be computed",
    );
    assert.match(
      crm,
      /activeHrKeys\.has\(key\) \|\| \(crmIdText !== "" && activeCrmIds\.has\(crmIdText\)\)/,
      "signal must be checked on BOTH the hr-id and the crm_id — visits carry either",
    );
  }
  // The visible category list must stay a strict subset of the canonical one, and it may hide
  // exactly TWO things, each for its own stated reason:
  //   · no_records_activity — its connector was retired once it lost its population (field
  //     workforce -> crm, Head Office has no CRM obligation, which is everybody);
  //   · no_weekly_plan — it is a DAILY-module connector and is deliberately absent from
  //     DEDUCTION_COLLECTORS, so the month workspace would show a permanently empty tab. Nothing
  //     is charged without the Super Admin releasing the daily line (owner, 2026-10-12: "never
  //     fired automatic always under the approval of system admin").
  // Narrowing `deductionsCategories` itself would break the DB enum and every historical row, so
  // the two lists are deliberately separate and this pins the relationship between them.
  {
    const canonical = new Set<string>(deductionsCategories);
    const visible = new Set<string>(visibleDeductionsCategories);
    for (const category of visible) {
      assert.ok(canonical.has(category), `visible category "${category}" is not a real DeductionsCategory`);
    }
    const hidden = [...canonical].filter((category) => !visible.has(category));
    assert.deepEqual(
      hidden,
      ["no_records_activity", "no_weekly_plan"],
      "a new category must be shown in the workspace or its exclusion justified here — silently hiding one is how a whole deduction category goes unreviewed",
    );
    assert.ok(
      !DEDUCTION_COLLECTORS.some((collector) => collector.key === "no_records_activity"),
      "no_records_activity must not be a live collector: its connector returns nothing, so a registered step reports created=0 forever and is indistinguishable from a broken connector",
    );
    // Widened to `string` deliberately. `DeductionCollectorKey` does not contain "no_weekly_plan"
    // today, so a direct comparison is a TS2367 "no overlap" error — the type system already
    // enforces half of this rule. The runtime check is what survives someone widening that union
    // later, which is the moment this assertion has to fire rather than stop compiling.
    assert.ok(
      !DEDUCTION_COLLECTORS.some((collector) => (collector.key as string) === "no_weekly_plan"),
      "no_weekly_plan must not be a live collector: it is the DAILY module's connector, and registering it here would let a month scan write the ledger automatically — the one thing the owner ruled out",
    );
  }
}