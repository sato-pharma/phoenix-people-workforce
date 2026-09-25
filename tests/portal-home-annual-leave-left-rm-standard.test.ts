import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * PR #4411 fixed the Medical Rep portal home tile, which read `leaveEntitlementDays` — the raw
 * yearly grant — and never subtracted approved paid days already taken. The same latent bug sat
 * in two more dashboards that render an identical "leave balance" tile from the same snapshot:
 *
 *   - RmCommandCenter (rm-command-center.tsx), the Regional Manager home
 *   - StandardCommandCenter (portal-command-center.tsx), the fallback used for DSM/NSM/Training
 *     Manager/etc.
 *
 * Both now read `leaveDaysRemaining` (computed via getEmployeeAnnualLeaveBalanceDays, through
 * buildEmployeeEligibilityRows — see portal-home-annual-leave-left.test.ts for that math) instead
 * of `leaveEntitlementDays`.
 *
 * PmGpmCommandCenter is DELIBERATELY untouched: it shows the raw entitlement labelled "annual
 * entitlement" on purpose, and must keep reading leaveEntitlementDays.
 */

function functionBody(source: string, marker: string): string {
  const start = source.indexOf(marker);
  assert.ok(start > 0, `${marker} must exist`);
  const nextFn = source.indexOf("\nfunction ", start + 1);
  const nextExported = source.indexOf("\nexport function ", start + 1);
  const candidates = [nextFn, nextExported].filter((index) => index > 0);
  return source.slice(start, candidates.length > 0 ? Math.min(...candidates) : undefined);
}

export function runPortalHomeAnnualLeaveLeftRmStandardTests() {
  // 1. RmCommandCenter must read leaveDaysRemaining, never fall back to the raw entitlement.
  {
    const source = readFileSync(
      new URL("../src/components/employee-portal/dashboards/rm-command-center.tsx", import.meta.url),
      "utf8",
    );
    const body = functionBody(source, "export function RmCommandCenter(");

    assert.match(body, /leaveDaysRemaining/, "RmCommandCenter must read leaveDaysRemaining");
    assert.ok(!body.includes("leaveEntitlementDays"), "RmCommandCenter must not fall back to the raw entitlement field");
    assert.match(
      body,
      /value: leaveDaysRemaining != null \? `\$\{leaveDaysRemaining\} days` : "—"/,
      "the RM tile's value must come from leaveDaysRemaining",
    );
    assert.match(body, /label: "annual leave left"/, 'the RM tile must be labelled "annual leave left"');
  }

  // 2. StandardCommandCenter (the DSM/NSM/Training Manager/etc. fallback) — same fix.
  {
    const source = readFileSync(new URL("../src/components/employee-portal/portal-command-center.tsx", import.meta.url), "utf8");
    const body = functionBody(source, "function StandardCommandCenter(");

    assert.match(body, /leaveDaysRemaining/, "StandardCommandCenter must read leaveDaysRemaining");
    assert.ok(!body.includes("leaveEntitlementDays"), "StandardCommandCenter must not fall back to the raw entitlement field");
    assert.match(
      body,
      /value: leaveDaysRemaining != null \? `\$\{leaveDaysRemaining\} days` : "—"/,
      "the StandardCommandCenter tile's value must come from leaveDaysRemaining",
    );
    assert.match(body, /label: "annual leave left"/, 'the StandardCommandCenter tile must be labelled "annual leave left"');

    // 3. PmGpmCommandCenter is a DIFFERENT, intentional tile ("annual entitlement") and must be
    // left alone — this pins that the fix did not spread there by a global find/replace.
    const pmGpmBody = functionBody(source, "function PmGpmCommandCenter(");
    assert.match(pmGpmBody, /leaveEntitlementDays/, "PmGpmCommandCenter must keep reading the raw entitlement — this is by design");
  }
}
