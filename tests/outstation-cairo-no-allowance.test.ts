import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CAIRO_ALLOWANCE_EXCLUDED_GOVERNORATE,
  CAIRO_NO_ALLOWANCE_REASON,
  applyCairoNoAllowance,
  cairoTripEarnsNoAllowance,
} from "../src/lib/outstation/cairo-allowance-rule.ts";
import type { OutstationAllowanceBreakdown } from "../src/lib/outstation/types.ts";

// Owner rule (2026-08-15), given verbatim: "in outstation and expenses either manual or submitted
// by employee when the this employee is from any region and coming cairo no allowance this trip".
// He confirmed the two boundaries in-session:
//   1. "Cairo" = the CAIRO GOVERNORATE ONLY. Giza / Qalyubia are separate and still earn an allowance.
//   2. Only the per-diem ALLOWANCE is removed — transport, tickets, meeting and other costs still pay.
//
// This file pins both halves: the pure decision + row transform (assertable without a database, the
// same discipline the duplicate-day guard uses), and the WIRING — that all four allowance write
// paths (employee submit, admin preview, admin create, admin edit) feed the two governorates into
// the single guarded calculation, so no path can silently pay a Cairo allowance the rule forbids.

const SERVICE = join(process.cwd(), "src/lib/outstation/service.ts");

/** A minimal single-day breakdown for the transform tests. */
function sameDayBreakdown(amount: number): OutstationAllowanceBreakdown {
  return {
    overnightDays: 0,
    returnDayApplied: false,
    rows: [{ amount, label: "Same day allowance", type: "same_day" }],
    sameDayTrip: true,
  };
}

/** A 2-overnight + return-day breakdown for the multi-row transform tests. */
function overnightBreakdown(overnight: number, returnDay: number): OutstationAllowanceBreakdown {
  return {
    overnightDays: 2,
    returnDayApplied: true,
    rows: [
      { amount: overnight, label: "Overnight allowance day 1", type: "overnight" },
      { amount: overnight, label: "Overnight allowance day 2", type: "overnight" },
      { amount: returnDay, label: "Return day allowance", type: "return_day" },
    ],
    sameDayTrip: false,
  };
}

export function runOutstationCairoNoAllowanceTests() {
  // ── The decision: who loses the allowance ────────────────────────────────────

  assert.equal(
    CAIRO_ALLOWANCE_EXCLUDED_GOVERNORATE,
    "Cairo",
    "the excluded governorate must be the canonical resolveGovernorate name for Cairo — a mismatch would silently never fire the rule",
  );

  assert.equal(
    cairoTripEarnsNoAllowance("Assiut", "Cairo"),
    true,
    "a regional employee (Assiut) travelling to Cairo earns no allowance — the owner's core rule",
  );
  assert.equal(
    cairoTripEarnsNoAllowance("Alexandria", "Cairo"),
    true,
    "any non-Cairo residence counts as 'from a region' — Alexandria to Cairo is covered too",
  );

  assert.equal(
    cairoTripEarnsNoAllowance("Cairo", "Cairo"),
    false,
    "a Cairo-based employee is NOT 'from a region' — a Cairo→Cairo trip is the existing same-governorate rule's job, not this one",
  );

  assert.equal(
    cairoTripEarnsNoAllowance("Assiut", "Giza"),
    false,
    "the owner scoped the destination to the Cairo governorate ONLY — Giza (6th October, Sheikh Zayed) still earns an allowance",
  );
  assert.equal(
    cairoTripEarnsNoAllowance("Assiut", "Qalyubia"),
    false,
    "Qalyubia is a separate governorate — a trip there still earns an allowance; it must not be folded into a 'Greater Cairo'",
  );

  assert.equal(
    cairoTripEarnsNoAllowance("Assiut", "Minya"),
    false,
    "a region-to-region trip is untouched by the Cairo rule",
  );

  for (const unresolved of [null, undefined, ""]) {
    assert.equal(
      cairoTripEarnsNoAllowance(unresolved, "Cairo"),
      false,
      "an unresolved residence must NEVER zero an allowance on a guess — that case is held for Super Admin review by the existing governorate rule, not silently stripped here",
    );
    assert.equal(
      cairoTripEarnsNoAllowance("Assiut", unresolved),
      false,
      "an unresolved destination must not fire the rule",
    );
  }

  // ── The transform: what actually gets zeroed ─────────────────────────────────

  {
    const input = sameDayBreakdown(120);
    const result = applyCairoNoAllowance(input);
    assert.equal(result.allowanceAmount, 0, "the trip's allowance is zero once the rule applies");
    assert.equal(result.removedAmount, 120, "removedAmount reports exactly what the rule took away");
    assert.equal(result.breakdown.rows[0].amount, 0, "the allowance row is zeroed");
    assert.equal(result.breakdown.rows[0].skipped, true, "the zeroed row is flagged skipped");
    assert.equal(
      result.breakdown.rows[0].skipReason,
      CAIRO_NO_ALLOWANCE_REASON,
      "the zeroed row must carry the human-readable reason — never a silent zero (owner's standing rule)",
    );
    assert.equal(input.rows[0].amount, 120, "the input breakdown must not be mutated");
  }

  {
    const result = applyCairoNoAllowance(overnightBreakdown(200, 100));
    assert.equal(result.removedAmount, 500, "every allowance row (2×200 overnight + 100 return day) is removed");
    assert.equal(result.allowanceAmount, 0, "a multi-day trip's allowance is fully zeroed");
    assert.ok(
      result.breakdown.rows.every((row) => row.amount === 0 && row.skipped),
      "every row is zeroed and flagged",
    );
  }

  {
    // A row already zeroed by the duplicate-day guard keeps its OWN reason — the Cairo rule never
    // overwrites an earlier explanation, and it does not double-count an already-removed day.
    const dupReason = "Allowance for 2026-08-08 was already granted on request #61 — not paid twice.";
    const input: OutstationAllowanceBreakdown = {
      overnightDays: 0,
      returnDayApplied: false,
      rows: [{ amount: 0, label: "Same day allowance", skipped: true, skipReason: dupReason, type: "same_day" }],
      sameDayTrip: true,
    };
    const result = applyCairoNoAllowance(input);
    assert.equal(result.removedAmount, 0, "an already-zeroed row contributes nothing to removedAmount");
    assert.equal(
      result.breakdown.rows[0].skipReason,
      dupReason,
      "the earlier guard's reason must survive — the Cairo rule must not clobber why a day was already skipped",
    );
  }

  // ── Wiring: every write path must feed the rule ──────────────────────────────

  const service = readFileSync(SERVICE, "utf8");

  assert.ok(
    service.includes("cairoTripEarnsNoAllowance(") && service.includes("applyCairoNoAllowance("),
    "the guarded allowance calculation must apply the Cairo rule — otherwise the whole feature is dead code",
  );

  const writePaths = [
    "calculateOutstationExpense",
    "previewManagerExpenseCalculation",
    "createManagerExpenseAsAdmin",
    "updateManagerExpenseAsAdmin",
  ];
  for (const name of writePaths) {
    const start = service.indexOf(`export async function ${name}(`);
    assert.notEqual(start, -1, `${name} must exist in service.ts — this test is pinned to it by name`);
    const next = service.indexOf("\nexport async function ", start + 1);
    const body = service.slice(start, next === -1 ? service.length : next);
    assert.ok(
      /residenceGovernorate/.test(body) && /destinationGovernorate/.test(body),
      `${name} must feed both residenceGovernorate and destinationGovernorate into the guarded allowance calculation — a path that omits them would keep paying a Cairo allowance the owner's rule forbids`,
    );
  }
}
