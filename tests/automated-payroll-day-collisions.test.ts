import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  describePayrollDayCollisions,
  detectPayrollDayCollisions,
} from "../src/lib/automated-payroll/day-collisions.ts";
import type { EmployeeDeductions } from "../src/lib/automated-payroll/deductions-source.ts";
import type { PopulationMember } from "../src/lib/automated-payroll/recommend.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";

/**
 * ONE ABSENCE DAY, CHARGED ONCE — on the path that actually pays people.
 *
 * THE RULE ALREADY EXISTED AND PAYROLL NEVER RAN IT. The Deductions module refuses to publish a
 * month in which two detectors claim the same employee-day, telling the reviewer to "clear the
 * wrong one or the month cannot be published", and a database trigger backstops the publication.
 * Automated Payroll reads that module's approved candidates and deliberately never calls its
 * publish step, so for the money that reaches a payslip the rule was never enforced at all.
 *
 * Three of the five detectors avoid the overlap when they create a candidate: vacation and
 * holiday-bridge drop a day another live candidate already claims, and no-record only reports
 * field-force days CRM did not already find. FINGERPRINT AND CRM ARE THE PAIR THAT DOES NOT.
 *
 * ARMED, NEVER FIRED. Applying the module's own rule to every approved candidate on production
 * finds zero real collisions. The single overlapping pair there is a manual entry whose "date" is
 * a placeholder rather than a day anybody was absent — correctly not a collision, and the reason
 * the source system has to be carried as far as payroll.
 */

function member(hrId: string, fullName: string): PopulationMember {
  return {
    employee: { hrId, fullName, hireDate: "2024-01-01" } as unknown as EmployeeDirectoryRow,
    compact: hrId.toLowerCase().replace(/[^a-z0-9]+/g, ""),
    lifecycle: "regular",
    lastWorkingDate: null,
    noticeLastWorkingDate: null,
  };
}

type Line = EmployeeDeductions["lines"][number];

function line(overrides: Partial<Line> & Pick<Line, "category" | "dates">): Line {
  return {
    days: 1,
    chargeableDays: 1,
    amount: 500,
    reason: "",
    status: "Approved for Payroll",
    sourceSystem: "crm_visits_mirror",
    ...overrides,
  } as Line;
}

function deductions(entries: Record<string, { lines?: Line[]; pendingLines?: Line[] }>) {
  const map = new Map<string, EmployeeDeductions>();
  for (const [compact, entry] of Object.entries(entries)) {
    map.set(compact, {
      buckets: {} as EmployeeDeductions["buckets"],
      lines: entry.lines ?? [],
      pendingLines: entry.pendingLines ?? [],
    });
  }
  return map;
}

export function runAutomatedPayrollDayCollisionTests() {
  const ayman = member("B-1", "Ayman Mohamed");
  const mona = member("B-2", "Mona Hassan");

  // ---- HEADLINE: fingerprint and CRM both claiming one day -------------------------------------
  // The pair with nothing between them. Neither connector consults what the other has claimed.
  const both = detectPayrollDayCollisions({
    members: [ayman],
    deductions: deductions({
      b1: {
        lines: [
          line({ category: "fingerprint", dates: ["2026-07-01"], sourceSystem: "attendance_mirror" }),
          line({ category: "crm", dates: ["2026-07-01"] }),
        ],
      },
    }),
  });
  assert.equal(both.length, 1, "one day claimed twice is one collision");
  assert.equal(both[0]?.fullName, "Ayman Mohamed", "named, never an HR code");
  assert.equal(both[0]?.date, "2026-07-01");
  assert.deepEqual(both[0]?.categories, ["crm", "fingerprint"], "both claimants are named");

  // ---- A MANUAL ENTRY IS NOT A CLAIM ON A DAY ---------------------------------------------------
  // This is the live case on production and the reason the source system is carried this far. A
  // manual deduction's date is a placeholder, not a day somebody was absent, so the module's rule
  // skips it. Counting it would send HR to clear something that is not wrong.
  const manual = detectPayrollDayCollisions({
    members: [ayman],
    deductions: deductions({
      b1: {
        lines: [
          line({ category: "crm", dates: ["2026-07-01"] }),
          line({ category: "other", dates: ["2026-07-01"], sourceSystem: "manual_hr" }),
        ],
      },
    }),
  });
  assert.deepEqual(manual, [], "a manual entry's placeholder date is not a second claim on that day");

  // ---- ONLY WHAT PAYROLL WILL ACTUALLY CHARGE ----------------------------------------------------
  // The module checks every live candidate; payroll checks only the approved ones. A clash where
  // one side is still pending costs nobody anything, and raising it would send HR to clear
  // something that was never going to be charged twice.
  const onePending = detectPayrollDayCollisions({
    members: [ayman],
    deductions: deductions({
      b1: {
        lines: [line({ category: "crm", dates: ["2026-07-01"] })],
        pendingLines: [
          line({ category: "fingerprint", dates: ["2026-07-01"], status: "Pending", sourceSystem: "attendance_mirror" }),
        ],
      },
    }),
  });
  assert.deepEqual(onePending, [], "a pending candidate is charged nothing, so it collides with nothing");

  // ---- The same category twice on one day is not a cross-claim -----------------------------------
  const sameCategory = detectPayrollDayCollisions({
    members: [ayman],
    deductions: deductions({
      b1: {
        lines: [
          line({ category: "crm", dates: ["2026-07-01"] }),
          line({ category: "crm", dates: ["2026-07-01"] }),
        ],
      },
    }),
  });
  assert.deepEqual(sameCategory, [], "one detector reporting a day twice is a module concern, not a double charge here");

  // ---- Different days, and different people, do not collide ---------------------------------------
  const clean = detectPayrollDayCollisions({
    members: [ayman, mona],
    deductions: deductions({
      b1: { lines: [line({ category: "crm", dates: ["2026-07-01"] })] },
      b2: { lines: [line({ category: "fingerprint", dates: ["2026-07-01"], sourceSystem: "attendance_mirror" })] },
    }),
  });
  assert.deepEqual(clean, [], "two people absent on the same day is not one day charged twice");

  // ---- Somebody off this run's roster is not this run's problem ------------------------------------
  const offRoster = detectPayrollDayCollisions({
    members: [mona],
    deductions: deductions({
      b1: {
        lines: [
          line({ category: "fingerprint", dates: ["2026-07-01"], sourceSystem: "attendance_mirror" }),
          line({ category: "crm", dates: ["2026-07-01"] }),
        ],
      },
    }),
  });
  assert.deepEqual(offRoster, [], "an employee this run does not pay cannot be double-charged by it");

  // ---- Several days, reported in a stable order -----------------------------------------------------
  const many = detectPayrollDayCollisions({
    members: [mona, ayman],
    deductions: deductions({
      b1: {
        lines: [
          line({ category: "fingerprint", dates: ["2026-07-05", "2026-07-02"], sourceSystem: "attendance_mirror" }),
          line({ category: "crm", dates: ["2026-07-02", "2026-07-05"] }),
        ],
      },
      b2: {
        lines: [
          line({ category: "fingerprint", dates: ["2026-07-03"], sourceSystem: "attendance_mirror" }),
          line({ category: "crm", dates: ["2026-07-03"] }),
        ],
      },
    }),
  });
  assert.deepEqual(
    many.map((collision) => `${collision.fullName} ${collision.date}`),
    ["Ayman Mohamed 2026-07-02", "Ayman Mohamed 2026-07-05", "Mona Hassan 2026-07-03"],
    "by person then date, so a list read twice reads the same way",
  );

  // ---- The sentence that stops the confirm ------------------------------------------------------------
  const message = describePayrollDayCollisions(both);
  assert.match(message, /Ayman Mohamed on 2026-07-01/, "it names the person and the day");
  assert.match(message, /crm \+ fingerprint/, "and which two claims to choose between");
  assert.match(
    message,
    /Clear the wrong claim in the Deductions module/,
    "and where to fix it — payroll cannot judge which claim is wrong",
  );
  assert.ok(!/B-1/.test(message), "never an HR code in something a person reads");
  assert.equal(describePayrollDayCollisions([]), "No employee-day is charged twice.");

  // ---- THE GATE IS WIRED, AND IS NOT ACKNOWLEDGEABLE ---------------------------------------------------
  // Everything above tests the rule. None of it can tell whether anything enforces it — which was
  // the entire defect: the rule existed in the Deductions module and payroll simply never ran it.
  const runService = readFileSync("src/lib/automated-payroll/run-service.ts", "utf8");
  const part2Start = runService.indexOf("export async function confirmPart2");
  const part2End = runService.indexOf("async function assembleForRun", part2Start);
  assert.ok(part2Start > 0 && part2End > part2Start, "confirmPart2 and its end marker must both be found");
  const part2Body = runService.slice(part2Start, part2End);
  assert.ok(part2Body.length < 16000, "the slice must stay bounded to confirmPart2");
  // The check must be CALLED and its result must STOP the confirm. Asserting only that the name
  // appears would pass on a body that merely mentions it, which is what a half-hearted revert
  // leaves behind — measured: that weaker form stayed green while the gate was gone.
  assert.match(
    part2Body,
    /detectPayrollDayCollisions\(\{[\s\S]{0,400}?\}\);/,
    "Part 2 confirm must actually run the day-collision check — the Deductions module's own gate " +
      "never runs on the payroll path, which is what let one day be charged twice",
  );
  assert.match(
    part2Body,
    /dayCollisions\.length > 0[\s\S]{0,200}?throw new Error\(/,
    "and a collision must stop the confirm, not merely be computed and dropped",
  );
  assert.ok(
    !/dayCollisions[\s\S]{0,200}acknowledge/i.test(part2Body),
    "and it must not be acknowledgeable: waving it through means charging somebody twice for one " +
      "day, which the module itself treats as something a human must clear",
  );
}
