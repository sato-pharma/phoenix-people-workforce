import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

// "Today" in the leave surfaces must be Cairo's calendar day, never the server's UTC clock and
// never the viewer's browser clock. Both defects below block a real person from acting during the
// 2-3 hours each night when Cairo is already on the next day and UTC is not.
export function runCairoLeaveTodayTests() {
  const vacationSource = readFileSync("src/lib/vacation/service.ts", "utf8");
  const excusesSource = readFileSync("src/lib/excuses/service.ts", "utf8");
  const excusesClientSource = readFileSync(
    "src/components/employee-portal/employee-excuses-workspace.tsx",
    "utf8",
  );

  // ── 1. Admin Entitlements table ────────────────────────────────────────────
  // buildEmployeeEligibilityRows' `today` is the reference date for the whole table:
  // getVacationBalancePeriod, calculateVacationPayment and daysUntilEligibility all hang off it.
  // On an employee's hire anniversary, a UTC "today" leaves the balance period on the PREVIOUS
  // entitlement year — old accrual, prior-year used days — so HR can reject a funded request.
  // The employee-facing twin (getVacationRequestPageData) has been Cairo-anchored since the
  // 2026-07-25 audit; this is its admin sibling.
  assert.doesNotMatch(
    vacationSource,
    /today:\s*toDateOnlyString\(new Date\(\)\)/,
    "the Entitlements table's reference date must not come from the server's own clock — it decides which entitlement year HR sees",
  );
  assert.match(
    vacationSource,
    /buildEmployeeEligibilityRows\(\{[\s\S]{0,1200}?today:\s*currentCairoDateOnlyIso\(\)/,
    "buildEmployeeEligibilityRows must take Cairo's calendar day as its reference date",
  );

  // ── 2. Excuse monthly allowance ────────────────────────────────────────────
  // The 2-per-month allowance is keyed on a YYYY-MM month key. A UTC key means that for the first
  // 2-3 hours of a Cairo month an employee who used both excuses last month is still counted
  // against LAST month — the client gates submission on `monthly.remaining <= 0`, so the UI
  // refuses a request the server would accept.
  assert.doesNotMatch(
    excusesSource,
    /function currentMonthKey\(\)\s*\{\s*return new Date\(\)\.toISOString\(\)/,
    "the excuse monthly-allowance month key must not come from the UTC clock — it gates a real entitlement",
  );
  assert.match(
    excusesSource,
    /currentCairoDateOnlyIso\(\)/,
    "excuses must resolve the current month from Cairo's calendar day",
  );

  // ── 3. Excuse form date default and its validator ──────────────────────────
  // These must agree. Before this fix the default was UTC (`toISOString`) while the validator
  // compared against the BROWSER-local day, so a Cairo rep opening the form at 00:30 got
  // yesterday pre-filled and was then told "Cannot submit excuses for past dates" — the form
  // opened pre-blocked, with submit disabled.
  assert.doesNotMatch(
    excusesClientSource,
    /function todayDate\(\)\s*\{\s*return new Date\(\)\.toISOString\(\)/,
    "the excuse date field must not default to the UTC day — inside a client component toISOString is UTC, not browser-local, so it is wrong even for a correctly-set Cairo machine",
  );
  assert.doesNotMatch(
    excusesClientSource,
    /const today = new Date\(now\.getFullYear\(\), now\.getMonth\(\), now\.getDate\(\)\)/,
    "the excuse date validator must not derive today from the viewer's browser clock",
  );
  assert.equal(
    (excusesClientSource.match(/currentCairoDateOnlyIso\(\)/g) ?? []).length >= 2,
    true,
    "both the excuse date default and its past-date validator must resolve today from Cairo, or they can disagree and pre-block the form",
  );
}
