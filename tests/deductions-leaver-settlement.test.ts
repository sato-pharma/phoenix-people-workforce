import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  hasEmploymentEnded,
  isFinalSettlementMonth,
  parseLastWorkingDate,
} from "../src/lib/deductions/settlement.ts";

/**
 * A leaver's last month was unrecordable by ANY route.
 *
 * Collection refuses a month that has not finished (correctly — see
 * deductions-current-month-guard.test.ts), and the manual entry route refused
 * anyone whose employment_status was terminal. So the moment HR marked someone
 * resigned, the month they had actually just worked could no longer be settled:
 * all 13 of August 2026's leavers sat in exactly that gap while their final
 * settlements were paid out.
 *
 * These tests pin the narrow door that fixes it, and — more importantly — the
 * two properties that keep it narrow.
 */
export async function runDeductionsLeaverSettlementTests(): Promise<void> {
  // ── parseLastWorkingDate reads the date as written, never via Date() ──────
  {
    assert.deepEqual(parseLastWorkingDate("2026-08-09"), { year: 2026, month: 8, day: 9 });
    assert.deepEqual(
      parseLastWorkingDate("2026-08-09T00:00:00+00:00"),
      { year: 2026, month: 8, day: 9 },
      "a timestamp column must yield the same calendar day as a date column",
    );
    assert.equal(parseLastWorkingDate(null), null);
    assert.equal(parseLastWorkingDate(undefined), null);
    assert.equal(parseLastWorkingDate(""), null);
    assert.equal(parseLastWorkingDate("not-a-date"), null);
    assert.equal(parseLastWorkingDate("2026-13-01"), null, "an impossible month must not parse");
    assert.equal(parseLastWorkingDate("2026-08-00"), null, "day zero must not parse");
  }

  // ── isFinalSettlementMonth: the month they actually left in, nothing else ─
  {
    assert.equal(isFinalSettlementMonth({ lastWorkingDate: "2026-08-09", month: 8, year: 2026 }), true);
    assert.equal(
      isFinalSettlementMonth({ lastWorkingDate: "2026-08-09", month: 7, year: 2026 }),
      false,
      "a leaver must not become a way to book deductions into an ARBITRARY earlier month",
    );
    assert.equal(
      isFinalSettlementMonth({ lastWorkingDate: "2026-08-09", month: 9, year: 2026 }),
      false,
      "nor into a month after they had already gone",
    );
    assert.equal(
      isFinalSettlementMonth({ lastWorkingDate: "2026-08-09", month: 8, year: 2025 }),
      false,
      "the same month number in a different YEAR is not their final month",
    );
    assert.equal(
      isFinalSettlementMonth({ lastWorkingDate: null, month: 8, year: 2026 }),
      false,
      "no recorded leaving date means there is nothing to settle",
    );
  }

  // ── hasEmploymentEnded: strictly past, measured in CAIRO ──────────────────
  {
    // 2026-08-23 15:00 Cairo (UTC+3 in August).
    const midAugust = new Date("2026-08-23T12:00:00Z");
    assert.equal(
      hasEmploymentEnded({ lastWorkingDate: "2026-08-09", now: midAugust }),
      true,
      "a last working day two weeks ago has ended — its days are judgeable",
    );
    assert.equal(
      hasEmploymentEnded({ lastWorkingDate: "2026-08-23", now: midAugust }),
      false,
      "TODAY is still running — same-day must be refused, exactly as the month guard refuses this month",
    );
    assert.equal(
      hasEmploymentEnded({ lastWorkingDate: "2026-08-31", now: midAugust }),
      false,
      "a leaving date still in the future must be refused",
    );
    assert.equal(hasEmploymentEnded({ lastWorkingDate: null, now: midAugust }), false);

    // 2026-08-24 00:30 Cairo, but still 23 August in UTC. A UTC clock would say
    // the 23rd has not ended; Cairo says it has. The month guard exists partly
    // because of this exact window, so the settlement gate must read it the
    // same way.
    const justPastCairoMidnight = new Date("2026-08-23T21:30:00Z");
    assert.equal(
      hasEmploymentEnded({ lastWorkingDate: "2026-08-23", now: justPastCairoMidnight }),
      true,
      "past Cairo midnight the previous day HAS ended — the gate must read Cairo, not UTC",
    );
  }

  // ── The load-bearing safety property: insert, never reconcile ────────────
  // Every automated connector reconciles its category or source scope, which
  // supersedes the month's live candidates a fresh scan no longer emits. A scan
  // filtered to ONE employee emits nothing for anyone else, so reconciling it
  // would supersede the entire month for everybody.
  {
    const settlement = readFileSync("src/lib/deductions/settlement.ts", "utf8");
    assert.match(
      settlement,
      /await insertCandidateDrafts\(/,
      "the settlement path must write through insertCandidateDrafts",
    );
    const callsReconcile = /\breconcileCandidateDrafts\s*\(/.test(settlement);
    assert.equal(
      callsReconcile,
      false,
      "the settlement path must NEVER call reconcileCandidateDrafts — a one-employee draft set would supersede every other employee's candidates for that month",
    );
    assert.match(
      settlement,
      /drafts: mine/,
      "only the target employee's drafts may be written",
    );
    assert.equal(
      /autoDecideStatus/.test(settlement),
      false,
      "a COMPUTED settlement candidate must reach HR as Pending — only a hand-typed manual entry auto-approves",
    );
    assert.match(
      settlement,
      /hasEmploymentEnded\(/,
      "eligibility must require the last working day to have passed",
    );
  }

  // ── The month guard itself is untouched ──────────────────────────────────
  {
    const collect = readFileSync("src/lib/deductions/collect.ts", "utf8");
    assert.match(
      collect,
      /return input\.year < year \|\| \(input\.year === year && input\.month < month\);/,
      "isCollectableMonth must still refuse the current and every future month — the settlement path is a door BESIDE this guard, never a weakening of it",
    );
  }

  // ── The manual route allows a leaver only for their own final month ──────
  {
    const manual = readFileSync("app/api/admin/deductions/manual/route.ts", "utf8");
    assert.match(
      manual,
      /isTerminalEmploymentStatus\(employee\.employment_status\)/,
      "the terminal-status check must still be the outer gate",
    );
    assert.match(
      manual,
      /isFinalSettlementMonth\(\{/,
      "a terminal employee must be admitted only via the final-settlement rule",
    );
    assert.match(
      manual,
      /if \(!settling\) \{/,
      "a terminal employee whose month is NOT their final month must still be refused",
    );
    assert.match(
      manual,
      /Number\.isInteger\(month\) \|\| month < 1 \|\| month > 12/,
      "month must be validated — the leaver gate depends on it, and an unchecked Number() produced a NaN month key",
    );
  }

  // ── The new route is declared in the access registry ─────────────────────
  // A route missing here ships without a declared permission; that exact
  // omission had to be fixed after the fact on the evidence-stamp route.
  {
    const registry = readFileSync("src/lib/security/access-registry.ts", "utf8");
    assert.match(
      registry,
      /pattern: "\/api\/admin\/deductions\/settlement".*resource: "deductions"/,
      "the settlement route must be declared in the access registry with the deductions resource",
    );
    assert.match(
      registry,
      /pattern: "\/api\/admin\/deductions\/settlement".*csrfRequired: true/,
      "the settlement route mutates and must require CSRF",
    );
  }
}
