// verified failing at f14ba5cc (pre-fix: resolveCycleWindowForTitle and
// resolvePayrollCycleMode did not exist — a single flat day-24 anchor applied
// to everyone)
//
// Owner rule (2026-08-01): the payroll month is role-dependent.
//   Head Office  -> 24th of the previous month .. 23rd of this one
//   Field force  -> the plain calendar month, 1st .. 30th/31st
//
// This decides which absences land in which payslip, so a wrong window does not
// produce a wrong-looking number — it produces a correct-looking number charged
// to the wrong month, which is far harder to spot.
//
// Real calendar months throughout (Feb 2026 = 28d, Jun = 30d, Jul = 31d) so an
// off-by-one in month length cannot hide behind a fixture.

import { strict as assert } from "node:assert";

import {
  PAYROLL_CYCLE_ANCHOR_DAY,
  resolveCycleWindow,
  resolveCycleWindowForTitle,
  resolvePayrollCycleMode,
} from "../src/lib/payroll/copilot/cycle-window.ts";

export function runPayrollCycleWindowRoleAwareTests() {
  // ── Who is on which month ────────────────────────────────────────────────
  assert.equal(resolvePayrollCycleMode("Medical Rep"), "field_force");
  assert.equal(resolvePayrollCycleMode("Medical Representative"), "field_force");
  assert.equal(resolvePayrollCycleMode("District Manager"), "field_force");
  assert.equal(resolvePayrollCycleMode("District Sales Manager"), "field_force");

  assert.equal(resolvePayrollCycleMode("Product Manager"), "head_office");
  assert.equal(resolvePayrollCycleMode("Group Product Manager"), "head_office");
  assert.equal(resolvePayrollCycleMode("Marketing Manager"), "head_office");
  assert.equal(resolvePayrollCycleMode("Training Manager"), "head_office");
  assert.equal(resolvePayrollCycleMode("Regional Manager"), "head_office");

  // Unknown / missing title must fall to Head Office, never field force. A
  // blank-title row on the calendar month would silently shift someone's
  // absences into a different payslip; the 24th window is the safer default
  // because it is what the system did for everyone before this change.
  assert.equal(resolvePayrollCycleMode(null), "head_office");
  assert.equal(resolvePayrollCycleMode(undefined), "head_office");
  assert.equal(resolvePayrollCycleMode(""), "head_office");
  assert.equal(resolvePayrollCycleMode("Chief Executive Officer"), "head_office");

  // ── Field force: the plain calendar month ────────────────────────────────
  {
    const july = resolveCycleWindowForTitle("2026-07-15", "Medical Rep");
    assert.equal(july.startIso, "2026-07-01");
    assert.equal(july.endIso, "2026-07-31", "July has 31 days");
    assert.equal(july.cycleKey, "2026-07", "a calendar month is keyed by ITSELF, not the month it ends in");
    assert.equal(july.anchorDay, 1);

    const june = resolveCycleWindowForTitle("2026-06-30", "District Manager");
    assert.equal(june.endIso, "2026-06-30", "June has 30 days");

    const feb = resolveCycleWindowForTitle("2026-02-10", "Medical Rep");
    assert.equal(feb.startIso, "2026-02-01");
    assert.equal(feb.endIso, "2026-02-28", "February 2026 has 28 days");
    assert.equal(feb.cycleKey, "2026-02");
  }

  // The 1st and the last day must both resolve to their OWN month — the two
  // days where an off-by-one would move an absence into a neighbouring payslip.
  {
    assert.equal(resolveCycleWindowForTitle("2026-07-01", "Medical Rep").cycleKey, "2026-07");
    assert.equal(resolveCycleWindowForTitle("2026-07-31", "Medical Rep").cycleKey, "2026-07");
    assert.equal(resolveCycleWindowForTitle("2026-12-31", "Medical Rep").cycleKey, "2026-12", "year-end must not roll");
    assert.equal(resolveCycleWindowForTitle("2026-01-01", "Medical Rep").cycleKey, "2026-01");
  }

  // ── Head Office: unchanged day-24 behaviour ──────────────────────────────
  // Asserted against resolveCycleWindow directly so a future change to one and
  // not the other is caught, rather than both drifting together.
  {
    const ho = resolveCycleWindowForTitle("2026-07-15", "Product Manager");
    assert.deepEqual(
      ho,
      resolveCycleWindow("2026-07-15", PAYROLL_CYCLE_ANCHOR_DAY),
      "Head Office must be byte-identical to the existing day-24 window",
    );
    assert.equal(ho.startIso, "2026-06-24");
    assert.equal(ho.endIso, "2026-07-23");
    assert.equal(ho.anchorDay, 24);
  }

  // The 23rd/24th boundary — the two days that decide which payslip a Head
  // Office absence belongs to.
  {
    assert.equal(resolveCycleWindowForTitle("2026-07-23", "Product Manager").cycleKey, "2026-07");
    assert.equal(resolveCycleWindowForTitle("2026-07-24", "Product Manager").cycleKey, "2026-08");
  }

  // ── The two populations genuinely differ ─────────────────────────────────
  // The whole point of the change: same date, different window by role. If this
  // ever passes trivially (both sides equal) the role branch has been lost.
  {
    const date = "2026-07-05";
    const field = resolveCycleWindowForTitle(date, "Medical Rep");
    const office = resolveCycleWindowForTitle(date, "Product Manager");
    assert.notEqual(field.startIso, office.startIso, "field force and Head Office must not share a window");
    assert.equal(field.startIso, "2026-07-01");
    assert.equal(office.startIso, "2026-06-24");
    // 5 July is in the JULY calendar month for a rep, but in the JULY day-24
    // cycle (24 Jun - 23 Jul) for Head Office — same key here, different range.
    assert.equal(field.cycleKey, "2026-07");
    assert.equal(office.cycleKey, "2026-07");
  }

  // Same date, DIFFERENT key — 30 July is still the July calendar month for a
  // rep, but already the August cycle for Head Office. This is the case that
  // moves money between payslips.
  {
    const date = "2026-07-30";
    assert.equal(resolveCycleWindowForTitle(date, "Medical Rep").cycleKey, "2026-07");
    assert.equal(resolveCycleWindowForTitle(date, "Product Manager").cycleKey, "2026-08");
  }
}
