import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { buildDays } from "../src/lib/phoenix-crm/server/plans.ts";
import { PENDING_VACATION_STATUSES } from "../src/lib/vacation/approved-leave-days.ts";

/**
 * Phoenix CRM plan — leave the rep ASKED for is named on his plan as pending approval, and once HR
 * approves it the day becomes a vacation by itself (owner, 2026-10-08: "if the employee submitted a
 * vacation show in his plan that it is pending approval; if approved, show these days are approved
 * vacations — automatically sync").
 *
 * THE RULES PINNED HERE:
 *   - a pending day is INFORMATION: the day stays plannable (its list types are untouched) and nothing is
 *     refused over it — only approved leave and a public holiday are days off;
 *   - approved leave outranks a request on the same day (no "pending" on a day that is already a vacation);
 *   - pending means waiting for a decision (the manager's, then HR's) — never a returned or rejected request;
 *   - the approved read is untouched: a request is not an absence, so nothing that asks "was he away" can
 *     start counting one.
 */

const ROOT = new URL("../", import.meta.url);

function source(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8"));
}

export function runPhoenixCrmPlanPendingVacationTests(): void {
  // ── The week the board builds ──────────────────────────────────────────────────────────────────
  const days = buildDays({
    weekStart: "2026-10-10",
    cairoToday: "2026-10-08",
    itemRows: [],
    farApartKm: 10,
    isRamadan: () => false,
    leave: new Map([["2026-10-11", "Annual Vacation"]]),
    pendingLeave: new Map([
      ["2026-10-11", "Annual Vacation"],
      ["2026-10-12", "Sick Vacation (half day)"],
    ]),
  });
  const byDate = new Map(days.map((day) => [day.date, day]));

  const approved = byDate.get("2026-10-11");
  assert.equal(approved?.dayOff?.kind, "leave", "approved leave is a day off");
  assert.equal(approved?.pendingLeave, null, "approved outranks a request on the same day");
  assert.deepEqual(approved?.listTypes, [], "an approved vacation day holds no customer");

  const pending = byDate.get("2026-10-12");
  assert.equal(pending?.pendingLeave, "Sick Vacation (half day)", "a request is named with its own leave type");
  assert.equal(pending?.dayOff, null, "a pending request is never a day off");
  assert.ok((pending?.listTypes.length ?? 0) > 0, "the day stays plannable while the request waits");

  assert.equal(byDate.get("2026-10-13")?.pendingLeave, null, "a day with no request says nothing");
  const noPending = buildDays({ weekStart: "2026-10-10", cairoToday: "2026-10-08", itemRows: [], farApartKm: 10, isRamadan: () => false });
  assert.ok(noPending.every((day) => day.pendingLeave === null), "a caller that sends no pending leave gets none");

  // ── The reads ──────────────────────────────────────────────────────────────────────────────────
  assert.deepEqual([...PENDING_VACATION_STATUSES], ["pending_manager", "pending_hr"], "waiting on a decision, never returned or rejected");
  const vacation = source("src/lib/vacation/approved-leave-days.ts");
  assert.match(vacation, /return loadLeaveDays\(\["approved"\], hrIds, range\);/, "the approved read still asks for approved alone");
  assert.match(vacation, /return loadLeaveDays\(PENDING_VACATION_STATUSES, hrIds, range\);/);

  const leaveDays = source("src/lib/phoenix-crm/server/leave-days.ts");
  const pendingLoader = /export async function loadSeatPendingLeave[\s\S]*?\n\}/.exec(leaveDays)?.[0] ?? "";
  assert.ok(pendingLoader, "the plan's pending read exists");
  assert.match(pendingLoader, /catch \(error\)/, "a failed read never fails the plan");
  assert.match(pendingLoader, /\(half day\)/, "a half day says so");
  assert.doesNotMatch(pendingLoader, /throw /, "it never throws");

  for (const builder of ["src/lib/phoenix-crm/server/plans.ts", "src/lib/phoenix-crm/server/monthly-plans.ts"]) {
    const text = source(builder);
    assert.match(text, /loadSeatPendingLeave\(seat, /, `${builder} reads the pending leave`);
    assert.match(text, /holidays, leave, pendingLeave \}\)/, `${builder} hands it to the day builder`);
  }

  // ── What the rep reads ─────────────────────────────────────────────────────────────────────────
  const week = source("src/components/phoenix-crm/plan-week-panel.tsx");
  assert.match(week, /Vacation pending approval/, "the day picker names a pending request");
  assert.match(week, /\$\{off\.name\} · approved/, "the day picker names approved leave as approved");
  const day = source("src/components/phoenix-crm/plan-day-panel.tsx");
  assert.match(day, /Vacation · pending approval/, "the day's pill");
  assert.match(day, /Vacation · approved/, "approved leave's pill");
  assert.match(day, /You can still plan this day; once it is approved the day holds no customer\./, "the note says the day is still his to plan");

  console.log("phoenix-crm plan pending vacation: OK");
}
