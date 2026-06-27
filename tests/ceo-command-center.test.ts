import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { resolveLandingPathForRole } from "../src/lib/auth/landing.ts";
import {
  buildCompanyWorkforceAggregateMetrics,
  canReadCompanyWorkforceAggregates,
} from "../src/lib/platform/metrics.ts";

export function runCeoCommandCenterTests() {
  // The CEO now lands on their dedicated, branded command center (was /sales).
  assert.equal(
    resolveLandingPathForRole("CEO"),
    "/admin/ceo-command-center",
    "CEO must land on the CEO Command Center",
  );
  // Landing normalizes case/whitespace, so variants resolve the same.
  assert.equal(resolveLandingPathForRole(" ceo "), "/admin/ceo-command-center");

  // Other roles' landings must be unchanged by this feature.
  assert.equal(resolveLandingPathForRole("Super Admin"), "/admin");
  assert.equal(
    resolveLandingPathForRole("Finance Manager"),
    "/admin/outstation/expense-command",
  );
  assert.equal(resolveLandingPathForRole("Employee"), "/employee-portals");
  assert.equal(resolveLandingPathForRole("Medical Rep"), "/employee-portals");

  const commandCenterSource = readFileSync("src/lib/admin/command-center.ts", "utf8");
  const platformSource = readFileSync("src/lib/platform/metrics.ts", "utf8");
  assert.match(
    commandCenterSource,
    /activeEmployees: platformMetrics\.workforce\.activeEmployees/,
    "CEO Command Center HR cards must render shared platform workforce metrics",
  );
  assert.match(
    platformSource,
    /canReadCompanyWorkforceAggregates\(accessContext\)/,
    "CEO Command Center workforce metrics must use the CEO-safe aggregate path",
  );
  assert.equal(
    canReadCompanyWorkforceAggregates({ role: "CEO", scope: "company", source: "session" }),
    true,
    "CEO must be allowed to read company workforce aggregates",
  );
  const workforce = buildCompanyWorkforceAggregateMetrics({
    employees: [
      { areaName: "Cairo", employmentStatus: "active", fullName: "Alpha", hrId: "A-1", lineName: "Line 1", managerHrId: "AA" },
      { areaName: "Giza", employmentStatus: "on_leave", fullName: "Beta", hrId: "A-2", lineName: "Line 1", managerHrId: "AA" },
    ],
    lookups: {
      workforceVacancies: [],
    },
  });
  assert.ok(
    workforce.activeEmployees > 0,
    "CEO Command Center must show non-zero workforce metrics when employees exist",
  );
}
