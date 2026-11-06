import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  normalizeAppliedDeductionDates,
  resolveAppliedDeductionDates,
  scaleDeductionAmountToDays,
} from "../src/lib/deductions/calculations.ts";
import { findDayCollisions } from "../src/lib/deductions/conflict.ts";
import { resolveDecisionCharge } from "../src/lib/deductions/service.ts";
import type { DeductionsCandidateWithDecision, DeductionsDecision } from "../src/lib/deductions/types.ts";

function decision(overrides: Partial<DeductionsDecision> = {}): DeductionsDecision {
  return {
    id: "d1",
    candidateId: "c1",
    decisionStatus: "Pending",
    decisionReason: "",
    hrNote: "",
    appliedValue: null,
    appliedAmount: null,
    appliedDates: null,
    decidedBy: null,
    decidedAt: null,
    actorRoleAtDecision: null,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
    ...overrides,
  };
}

function candidate(overrides: Partial<DeductionsCandidateWithDecision> = {}): DeductionsCandidateWithDecision {
  return {
    id: "c1",
    category: "crm",
    sourceSystem: "test",
    sourceRecordId: "rec-1",
    candidateKey: "key-1",
    employeeHrId: "B-124",
    employeeHrIdCompact: "b124",
    employeeName: "Test Employee",
    monthKey: "2026-07",
    month: 7,
    year: 2026,
    unit: "days",
    rawValue: 4,
    estimatedAmount: 400,
    calculationStatus: "calculated",
    severity: null,
    reason: null,
    evidence: {},
    dates: ["2026-07-03", "2026-07-07", "2026-07-14", "2026-07-21"],
    hierarchySnapshot: {},
    createdBy: "system",
    createdAt: "2026-07-01T00:00:00Z",
    refreshedAt: null,
    lockedAt: null,
    supersededAt: null,
    supersededByCandidateId: null,
    decision: null,
    ...overrides,
  };
}

export async function runDeductionsModuleAppliedDaysTests(): Promise<void> {
  // ── A reviewer can only REMOVE days, never invent one ─────────────────────
  // A deduction is evidence-backed. Accepting a day the engine never detected
  // would let the review screen charge somebody for a day nothing observed.
  {
    const detected = ["2026-07-03", "2026-07-07"];

    const clean = normalizeAppliedDeductionDates({ candidateDates: detected, selected: ["2026-07-07"] });
    assert.deepEqual(clean.dates, ["2026-07-07"]);
    assert.deepEqual(clean.rejected, [], "a detected day must be accepted");

    const invented = normalizeAppliedDeductionDates({ candidateDates: detected, selected: ["2026-07-09"] });
    assert.deepEqual(invented.dates, [], "an undetected day must never be charged");
    assert.deepEqual(
      invented.rejected,
      ["2026-07-09"],
      "the rejected day must be REPORTED, not silently dropped — a selection that quietly shrinks lets a reviewer believe they charged a day they did not",
    );

    const messy = normalizeAppliedDeductionDates({
      candidateDates: detected,
      selected: ["2026-07-07", " 2026-07-07 ", "2026-07-03", "", 7],
    });
    assert.deepEqual(messy.dates, ["2026-07-03", "2026-07-07"], "duplicates collapse and the result is sorted");
    assert.deepEqual(messy.rejected, ["7"], "a non-string is rejected, not coerced");
  }

  // ── null and [] are OPPOSITE answers ──────────────────────────────────────
  // This is the whole reason applied_dates is nullable. `?? candidate.dates`
  // would read an explicitly-emptied selection as "charge every detected day",
  // and defaulting the column to '[]' would read every pre-existing decision in
  // the table as "charge nothing" — a silent, company-wide pay change either way.
  {
    const detected = ["2026-07-03", "2026-07-07", "2026-07-14", "2026-07-21"];

    assert.deepEqual(
      resolveAppliedDeductionDates(candidate({ decision: decision({ appliedDates: null }) })),
      detected,
      "a decision that never narrowed the days must still charge every detected day",
    );
    assert.deepEqual(
      resolveAppliedDeductionDates(candidate({ decision: null })),
      detected,
      "no decision row at all must still charge every detected day",
    );
    assert.deepEqual(
      resolveAppliedDeductionDates(candidate({ decision: decision({ appliedDates: [] }) })),
      [],
      "an explicitly emptied selection charges NOTHING — it must not fall back to the detected days",
    );
    assert.deepEqual(
      resolveAppliedDeductionDates(candidate({ decision: decision({ appliedDates: ["2026-07-07", "2026-07-14"] }) })),
      ["2026-07-07", "2026-07-14"],
      "a narrowed selection charges exactly the days that survived",
    );
  }

  // ── The amount follows the day count, proportionally ──────────────────────
  {
    assert.equal(
      scaleDeductionAmountToDays({ estimatedAmount: 400, rawValue: 4, appliedDays: 4 }),
      400,
      "an untouched candidate must return its estimate EXACTLY — re-deriving it must not move the figure by a rounding piaster",
    );
    assert.equal(scaleDeductionAmountToDays({ estimatedAmount: 400, rawValue: 4, appliedDays: 3 }), 300);
    assert.equal(scaleDeductionAmountToDays({ estimatedAmount: 400, rawValue: 4, appliedDays: 0 }), 0);
    assert.equal(
      scaleDeductionAmountToDays({ estimatedAmount: 1000, rawValue: 3, appliedDays: 1 }),
      333.33,
      "the amount is rounded to piastres",
    );
    assert.equal(
      scaleDeductionAmountToDays({ estimatedAmount: null, rawValue: 4, appliedDays: 2 }),
      null,
      '"we could not work out this amount" must stay null, never become 0.00 — publish refuses on null and would silently pay 0 on a zero',
    );
    assert.equal(
      scaleDeductionAmountToDays({ estimatedAmount: 400, rawValue: 0, appliedDays: 1 }),
      null,
      "a candidate detecting zero days has no rate to scale from",
    );
  }

  // ── The ticks drive the quantity; a typed quantity wins ───────────────────
  {
    const base = {
      unit: "days" as const,
      rawValue: 4,
      estimatedAmount: 400,
      dates: ["2026-07-03", "2026-07-07", "2026-07-14", "2026-07-21"],
    };

    const fromTicks = resolveDecisionCharge({
      candidate: base,
      appliedDates: ["2026-07-03", "2026-07-14", "2026-07-21"],
    });
    assert.equal(fromTicks.appliedValue, 3, "the quantity auto-populates from the ticked days");
    assert.equal(fromTicks.appliedAmount, 300, "and the amount follows the quantity");
    assert.deepEqual(fromTicks.appliedDates, ["2026-07-03", "2026-07-14", "2026-07-21"]);

    const typedOver = resolveDecisionCharge({
      candidate: base,
      appliedDates: ["2026-07-03", "2026-07-14", "2026-07-21"],
      appliedValue: 2,
    });
    assert.equal(typedOver.appliedValue, 2, "a typed quantity overrides the tick count");
    assert.equal(typedOver.appliedAmount, 200, "and the amount follows the typed quantity");

    const untouched = resolveDecisionCharge({ candidate: base });
    assert.equal(untouched.appliedDates, null, "sending no selection must leave the days un-narrowed, not empty them");
    assert.equal(untouched.appliedValue, null);
    assert.equal(untouched.appliedAmount, null);
  }

  // ── Deciding a candidate must not WIPE the days already chosen ────────────
  // The decision row is written with an upsert of every column, and the plain
  // "Decide" action carries no day information at all. If an absent field were
  // written as null, approving a deduction the reviewer had already trimmed
  // from 14 days to 3 would silently put it back to 14.
  {
    const route = readFileSync("app/api/admin/deductions/decisions/route.ts", "utf8");
    assert.match(
      route,
      /hasOwnProperty\.call\(body, key\)/,
      "the route must tell an ABSENT field apart from an explicit null — collapsing both to null is what blanks a saved day selection",
    );
    assert.match(
      route,
      /appliedDates: has\("appliedDates"\)/,
      "appliedDates must be passed as undefined when the caller never mentioned it",
    );

    const service = readFileSync("src/lib/deductions/service.ts", "utf8");
    assert.match(
      service,
      /input\.appliedDates === undefined/,
      "recordDecision must carry the stored day selection forward when the caller says nothing about it",
    );
    assert.match(
      service,
      /from\("deductions_decisions"\)\s*\n?\s*\.select\("(?=[^"]*\bapplied_value\b)(?=[^"]*\bapplied_dates\b)[^"]*"\)/,
      "recordDecision must READ the existing decision before upserting over it",
    );
    // Fail-open guard. maybeSingle() returns data null AND error null for an
    // absent row, so a non-null error is always a real failure. Swallowing it
    // would carry null forward into the upsert and blank the day selection while
    // still reporting the save as successful — the read would then be actively
    // worse than not reading at all.
    assert.match(
      service,
      /if \(existing\.error\) \{\s*\n?\s*throw new Error\(`Failed to load the existing deduction decision/,
      "a failed existing-decision read must throw, never be treated as 'there was nothing here'",
    );
  }

  // ── A typo must not become a 10x pay cut ──────────────────────────────────
  // Nothing downstream re-checks the day count against the evidence, so 140
  // typed instead of 14 would publish as 140 days of salary.
  {
    const base = { unit: "days" as const, rawValue: 4, estimatedAmount: 400, dates: ["2026-07-03"] };
    assert.throws(
      () => resolveDecisionCharge({ candidate: base, appliedValue: 40 }),
      /only 4 were detected/,
      "deducting more days than were detected must be refused",
    );
    // …except a figure the Super Admin raised on the weekly attendance review before release (owner,
    // 2026-09-15: "Raise too"). Only the attendance bridge passes the flag; the database caps the day at 3.
    const raised = resolveDecisionCharge({ candidate: base, appliedValue: 6, allowAboveDetected: true });
    assert.equal(raised.appliedValue, 6, "a day the Super Admin raised before release reaches payroll at his figure");
    assert.equal(raised.appliedAmount, 600, "and the amount follows it");
    assert.throws(
      () => resolveDecisionCharge({ candidate: base, appliedValue: 6 }),
      /only 4 were detected/,
      "without the flag, more days than were detected are still refused",
    );
    assert.throws(
      () => resolveDecisionCharge({ candidate: base, appliedValue: -1 }),
      /non-negative/,
      "a negative day count must be refused",
    );
    assert.throws(
      () => resolveDecisionCharge({ candidate: base, appliedDates: ["2026-07-09"] }),
      /never added/,
      "a day the engine never detected must be refused",
    );
  }

  // ── The amount is DERIVED, never accepted from the caller ─────────────────
  // The route is Super-Admin gated, but "only an admin can send it" is not the
  // same guarantee as "the number cannot be wrong", and this one is salary.
  {
    const route = readFileSync("app/api/admin/deductions/decisions/route.ts", "utf8");
    assert.doesNotMatch(
      route,
      /appliedAmount:\s*typeof body\.appliedAmount/,
      "the decisions route must NOT forward a caller-supplied amount — recordDecision re-derives it from the stored candidate",
    );
    assert.match(route, /appliedDates/, "the decisions route must accept the day selection");

    const service = readFileSync("src/lib/deductions/service.ts", "utf8");
    assert.match(
      service,
      /resolveDecisionCharge/,
      "recordDecision must route the day selection through resolveDecisionCharge rather than trusting the request body",
    );
  }

  // ── A CRM row's ticked days are priced on what they WEIGH (audit, 2026-11-07) ──
  // Mon 19 + Thu 22 Oct at 483.87 a day is 725.81. The editor always sends the quantity beside the
  // ticks, so unticking the Monday sends appliedValue 1 with one date — that still FOLLOWS the ticks
  // and must price the Thursday at its half day, never at half the money.
  {
    const crm = {
      unit: "days" as const,
      rawValue: 2,
      estimatedAmount: 725.81,
      dates: ["2026-10-19", "2026-10-22"],
      category: "crm",
    };
    const thursday = resolveDecisionCharge({ candidate: crm, appliedDates: ["2026-10-22"], appliedValue: 1 });
    assert.equal(thursday.appliedValue, 1, "the tick count is kept as the day value, as payroll reads it");
    assert.equal(thursday.appliedAmount, 241.94, "REGRESSION: an unticked CRM row keeps the Thursday at its half-day price");
    const monday = resolveDecisionCharge({ candidate: crm, appliedDates: ["2026-10-19"] });
    assert.equal(monday.appliedAmount, 483.87, "a kept full day is priced as a full day");
    const typed = resolveDecisionCharge({ candidate: crm, appliedDates: ["2026-10-19", "2026-10-22"], appliedValue: 1 });
    assert.equal(typed.appliedAmount, 362.91, "a quantity the reviewer TYPED over the ticks scales by the count");
  }

  // ── An amount is capped at what was entered, like days at what was detected ──
  {
    const loan = { unit: "amount" as const, rawValue: 5000, estimatedAmount: 5000, dates: [] as string[] };
    assert.throws(
      () => resolveDecisionCharge({ candidate: loan, appliedValue: 50000 }),
      /cannot deduct 50000 EGP — the entry is for 5000 EGP/,
      "REGRESSION: a 5,000 EGP loan typed as 50000 must never reach payroll",
    );
    assert.equal(resolveDecisionCharge({ candidate: loan, appliedValue: 1234.567 }).appliedAmount, 1234.57, "held to piasters");
  }

  // ── An amount-unit candidate has no days to tick ──────────────────────────
  {
    const loan = resolveDecisionCharge({
      candidate: { unit: "amount", rawValue: 500, estimatedAmount: 500, dates: [] },
      appliedValue: 250,
    });
    assert.equal(loan.appliedValue, 250);
    assert.equal(loan.appliedAmount, 250, "for an amount-unit candidate the applied value IS the money");
    assert.equal(loan.appliedDates, null, "an amount-unit candidate never carries a day selection");
  }

  // ── Unticking a day RESOLVES a cross-category double-deduction ────────────
  // The publish gate rejects a month where two categories claim the same
  // employee-day, and tells the reviewer to clear the wrong one. Run against
  // detected days, clearing it in the day picker changed the money but left the
  // gate still blocking — the one action the error names could not fix it.
  {
    const crm = candidate({
      id: "c-crm",
      category: "crm",
      dates: ["2026-07-07", "2026-07-14"],
    });
    const fingerprint = candidate({
      id: "c-fp",
      category: "fingerprint",
      candidateKey: "key-2",
      dates: ["2026-07-14"],
    });

    const beforeClearing = findDayCollisions(
      [crm, fingerprint].map((entry) => ({ ...entry, dates: resolveAppliedDeductionDates(entry) })),
    );
    assert.equal(beforeClearing.length, 1, "the same employee-day claimed by two categories must collide");
    assert.equal(beforeClearing[0].date, "2026-07-14");

    const crmWithoutTheClash = { ...crm, decision: decision({ appliedDates: ["2026-07-07"] }) };
    const afterClearing = findDayCollisions(
      [crmWithoutTheClash, fingerprint].map((entry) => ({ ...entry, dates: resolveAppliedDeductionDates(entry) })),
    );
    assert.deepEqual(
      afterClearing,
      [],
      "unticking the overlapping day in one category must resolve the collision — otherwise publish stays blocked on a day the reviewer already cleared",
    );
  }

  // ── Publish must PAY and RECORD the applied days ──────────────────────────
  // Wiring assertion: the composition above is only correct if publishMonth
  // actually uses it. It previously wrote `dates: candidate.dates` onto every
  // snapshot line, so a line reading "3 days" listed all 14 dates underneath.
  {
    const publish = readFileSync("src/lib/deductions/publish.ts", "utf8");
    assert.doesNotMatch(
      publish,
      /dates:\s*candidate\.dates/,
      "a publication line must carry the days actually charged, not every day detected",
    );
    assert.match(publish, /dates:\s*resolvePublishDates\(candidate\)/, "the snapshot line must use the applied days");
    assert.match(
      publish,
      /findDayCollisions\(\s*\n?\s*eligible\.map/,
      "the double-deduction gate must run on the applied days too, or clearing a day cannot unblock the publish",
    );
  }
}
