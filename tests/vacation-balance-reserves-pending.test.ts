import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { availableBalanceAfterPending } from "../src/lib/vacation/calculations.ts";

/**
 * The balance a person is shown must fall when they take leave — not weeks later when an approver
 * finally clicks. Requests sat in `pending_hr` for up to 41 days in production while the screen
 * kept reporting a full, untouched entitlement, so the same days could be booked twice.
 *
 * The fix is deliberately DISPLAY-ONLY, and that boundary is the thing this file protects:
 *
 *   - `approvedPaidDaysInPeriod` still counts ONLY `approved`. It feeds calculatePaymentForRequest,
 *     which decides paid vs unpaid, writes paid_duration_days onto the row, and is read again by
 *     automated payroll, the deduction connector and the Payroll Copilot settlement tab. Widening
 *     its status filter would change what people are PAID.
 *   - `pendingPaidDaysInPeriod` is a separate read, used only to render a number.
 *
 * A future session tidying these two into one function is the regression this guards.
 */

const SERVICE_SOURCE = readFileSync(new URL("../src/lib/vacation/service.ts", import.meta.url), "utf8");

function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start > 0, `${signature} must exist in the vacation service`);
  const nextFn = source.indexOf("\nasync function ", start + 1);
  const nextExported = source.indexOf("\nexport async function ", start + 1);
  const candidates = [nextFn, nextExported].filter((index) => index > 0);
  return source.slice(start, candidates.length > 0 ? Math.min(...candidates) : undefined);
}

export function runVacationBalanceReservesPendingTests() {
  // 1. The arithmetic the card shows.
  {
    assert.equal(availableBalanceAfterPending(21, 0), 21, "nothing pending leaves the balance alone");
    assert.equal(availableBalanceAfterPending(21, 2.5), 18.5, "held days come off the headline");
    assert.equal(availableBalanceAfterPending(6, 6), 0, "requesting exactly what is left reads zero");
  }

  // 2. It never goes negative. The module's own stated policy is that it "does not create negative
  // balance" — excess days are split into unpaid, not carried as debt — so the display must not
  // invent a negative either.
  {
    assert.equal(availableBalanceAfterPending(1, 5), 0, "requesting more than is left floors at zero");
    assert.equal(availableBalanceAfterPending(0, 3), 0, "no balance and a pending request stays at zero");
    assert.equal(availableBalanceAfterPending(21, -4), 21, "a negative reservation can never ADD balance");
  }

  // 3. Half days survive, and the result is rounded the same way every other balance figure is —
  // a rep taking AM-only leave must not turn the balance into a long float.
  {
    assert.equal(availableBalanceAfterPending(21, 0.5), 20.5, "a half day is held as a half day");
    assert.equal(availableBalanceAfterPending(7.5, 1.25), 6.25, "accrued first-year balances keep their quarters");
  }

  // 4. THE BOUNDARY. Pricing must stay approved-only: the function that decides what someone is
  // PAID must not learn about in-flight requests.
  {
    const pricing = functionBody(SERVICE_SOURCE, "async function approvedPaidDaysInPeriod(input: {");
    assert.match(
      pricing,
      /\.eq\("status", "approved"\)/,
      "approvedPaidDaysInPeriod must filter on status = approved and nothing else",
    );
    for (const inFlight of ["pending_hr", "pending_manager", "needs_assignment", "IN_FLIGHT_VACATION_STATUSES"]) {
      assert.ok(
        !pricing.includes(inFlight),
        `approvedPaidDaysInPeriod must not mention ${inFlight} — it prices requests and feeds payroll, `
        + "so reserving inside it would change what people are paid, not just what they see",
      );
    }
  }

  // 5. And the display read must cover every in-flight status, or leave stops being held the moment
  // it moves between approval stages — the balance would jump back up mid-flight.
  {
    const display = functionBody(SERVICE_SOURCE, "async function pendingPaidDaysInPeriod(input: {");
    assert.match(display, /\.in\("status", IN_FLIGHT_VACATION_STATUSES/, "the display read filters on the in-flight set");

    const statuses = SERVICE_SOURCE.slice(SERVICE_SOURCE.indexOf("const IN_FLIGHT_VACATION_STATUSES"));
    const declaration = statuses.slice(0, statuses.indexOf(";"));
    for (const status of ["needs_assignment", "pending_manager", "pending_hr"]) {
      assert.ok(declaration.includes(status), `${status} must be held — the leave is taken and undecided`);
    }
    for (const settled of ["approved", "rejected", "returned"]) {
      assert.ok(
        !declaration.includes(settled),
        `${settled} must NOT be held: approved is already counted by the pricing read (double-holding it), `
        + "and rejected/returned are not live requests",
      );
    }
  }

  // 6. Annual and emergency share one pool, so a held emergency day must come off the annual
  // balance too — otherwise the two screens disagree about the same day.
  {
    const display = functionBody(SERVICE_SOURCE, "async function pendingPaidDaysInPeriod(input: {");
    assert.match(
      display,
      /vacationType === "annual" \|\| input\.vacationType === "emergency"[\s\S]*\.in\("vacation_type", \["annual", "emergency"\]\)/,
      "the held-days read must pool annual and emergency exactly as the approved read does",
    );
  }

  // 7. A failed reservation read must degrade to the old approved-only number, never blank the
  // screen: this is the balance an employee needs to submit leave at all.
  {
    const display = functionBody(SERVICE_SOURCE, "async function pendingPaidDaysInPeriod(input: {");
    assert.match(display, /if \(error\) \{[\s\S]*return 0;/, "a read failure returns 0 held days rather than throwing");
  }
}
