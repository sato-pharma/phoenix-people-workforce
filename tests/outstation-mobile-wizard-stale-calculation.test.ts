import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Production evidence this file pins against, in the owner's data (2026-08-25, production
// ozucdzovmcqvepbozvqf, outstation_expense_requests id 99, Dina Fadel, area B-12): the trip end
// date was edited from a same-day return to an overnight stay AFTER the wizard had already priced
// the same-day version (fuel 216.90 + a same-day allowance of 125 = 341.90). Submit was pressed
// before the debounced recalculation for the new dates landed, and the wizard posted the stale
// 341.90 as `claimedTotalAmount` even though the server's own fresh calculation — shown on every
// screen — was 541.90 (overnight allowance 325). Payroll would have paid 200 EGP short.
//
// `calculation` (the wizard's local state) is set only on a successful /api/outstation/calculate
// response and, before this fix, was cleared on nothing but a full reset or a fresh location
// capture — never when the trip inputs it was priced from changed. `calculationKey` is the memo
// that changes with every pricing-relevant input; `lastCalculationKeyRef` tracks which key a
// calculation was last requested for. Two changes close the hole:
//   1. `calculation` nulls out the instant `calculationKey` changes (while online), which also
//      hides the submit action entirely — it renders only when `calculation` is set.
//   2. `submit()` no longer posts `calculation.expectedTotalAmount` as `claimedTotalAmount` at
//      all. The server (src/lib/outstation/service.ts) already recomputes the whole trip itself
//      and only trusts a posted claim when it is a real positive number (outstationClaimedTotal),
//      so leaving the client's value at 0 makes the server's own fresh total the one ever paid —
//      removing the vector even if some other gap let a stale submit through.
//
// This is a source-pinning test (regex against the raw component source), not a rendered-component
// test: this repo has no DOM/React-testing-library harness, and the established pattern for a
// client file like this is tests/outstation-claimed-total.test.ts, which pins service.ts the same
// way.

const WIZARD = join(process.cwd(), "src/components/outstation/mobile-outstation-wizard.tsx");

export function runOutstationMobileWizardStaleCalculationTests() {
  const wizard = readFileSync(WIZARD, "utf8");

  // ── The vector itself: submit() must never echo the wizard's own calculation back as a claim ──

  assert.ok(
    !/claimedTotalAmount:\s*calculation\?\.expectedTotalAmount/.test(wizard),
    "submit() must not post `calculation?.expectedTotalAmount` as claimedTotalAmount — that echo is exactly what let request 99 submit at the price computed for the OLD trip dates",
  );

  assert.ok(
    /claimedTotalAmount:\s*0,/.test(wizard),
    "requestPayload must still default claimedTotalAmount to 0 — submit() relies on this base value now that it no longer overrides it with the wizard's own calculation, matching the offline sync path's long-standing 'the server prices the whole trip, the client sends nothing' rule",
  );

  // ── The submit gate: refuse while pending, failed, or priced for different inputs ──

  assert.ok(
    /isCalculating\s*\|\|\s*!calculation\s*\|\|\s*lastCalculationKeyRef\.current\s*!==\s*calculationKey/.test(
      wizard,
    ),
    "submit() must block on all three shapes of 'not current': a calculation still in flight, no calculation at all, and a calculation computed for a calculationKey other than the one live right now",
  );

  // ── The staleness-clearing effect: calculation must not outlive the inputs it was priced from ──

  assert.ok(
    /useEffect\(\(\)\s*=>\s*\{\s*if\s*\(isOffline\)\s*return;\s*setCalculation\(null\);\s*\},\s*\[calculationKey,\s*isOffline\]\);/.test(
      wizard,
    ),
    "a dedicated effect must null `calculation` the instant calculationKey changes (skipped only while offline, where a recalculation cannot run without a server round trip) — without it the old total lingers on screen, submittable, after the trip inputs it priced have already moved on",
  );

  // ── The out-of-order-response guard: a late response must not resurrect a superseded price ──

  assert.ok(
    /submittedCalculationKey\s*&&\s*submittedCalculationKey\s*!==\s*lastCalculationKeyRef\.current/.test(
      wizard,
    ),
    "a /api/outstation/calculate response must be discarded once a NEWER calculation has already started (overwriting the ref) — otherwise a slow response for stale inputs can resolve after the newer request began and silently reinstate the price it was meant to replace",
  );
}
