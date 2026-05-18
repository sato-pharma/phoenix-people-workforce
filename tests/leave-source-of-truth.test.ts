import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  calculateVacationDurationDays,
} from "../src/lib/vacation/calculations.ts";
import {
  buildVacationPlatformMetrics,
  summarizeVacationRequests,
} from "../src/lib/vacation/metrics.ts";

export function runLeaveSourceOfTruthTests() {
  assert.equal(
    calculateVacationDurationDays({
      dayPart: "full_day",
      endDate: "2026-05-07",
      holidays: ["2026-05-05"],
      startDate: "2026-05-03",
    }),
    4,
    "Vacation duration should reuse HR Calendar working-day logic and exclude holidays",
  );

  assert.throws(
    () =>
      calculateVacationDurationDays({
        dayPart: "am_only",
        endDate: "2026-05-05",
        holidays: ["2026-05-05"],
        startDate: "2026-05-05",
      }),
    /working day/,
    "Half-day vacation should reject HR Calendar holidays",
  );

  const rows = [
    {
      canDecide: true,
      durationDays: 2,
      managerDecision: null,
      paymentStatus: "paid" as const,
      status: "pending_manager" as const,
    },
    {
      canDecide: false,
      durationDays: 3,
      managerDecision: "approved" as const,
      paymentStatus: "paid" as const,
      status: "approved" as const,
    },
    {
      canDecide: false,
      durationDays: 1,
      managerDecision: "rejected" as const,
      paymentStatus: "unpaid" as const,
      status: "rejected" as const,
    },
  ];

  assert.deepEqual(summarizeVacationRequests(rows), {
    approved: 1,
    managerDecisionActions: 3,
    paidDays: 5,
    pending: 1,
    rejected: 1,
    total: 3,
    unpaidDays: 1,
  });
  assert.deepEqual(buildVacationPlatformMetrics(rows), {
    approvedRequests: 1,
    managerDecisionActions: 3,
    paidDays: 5,
    pendingRequests: 1,
    rejectedRequests: 1,
    totalRequests: 3,
    unpaidDays: 1,
  });

  const calculationSource = readFileSync("src/lib/vacation/calculations.ts", "utf8");
  assert.match(calculationSource, /countHrWorkingDays/);
  assert.match(calculationSource, /isHrWorkingDay/);

  const serviceSource = readFileSync("src/lib/vacation/service.ts", "utf8");
  assert.match(serviceSource, /summarizeVacationRequests/);
  assert.doesNotMatch(serviceSource, /rows\.filter\(\(row\) => row\.status === "approved"\)\.length/);

  const requestSource = readFileSync("src/components/vacation/vacation-request-form.tsx", "utf8");
  assert.match(requestSource, /calculateVacationDurationDays/);

  const platformSource = readFileSync("src/lib/platform/metrics.ts", "utf8");
  assert.match(platformSource, /buildVacationPlatformMetrics/);
  assert.match(platformSource, /getVacationReportData/);

  const overviewSource = readFileSync("src/lib/overview/service.ts", "utf8");
  assert.match(overviewSource, /platformMetrics\.leave\.pendingRequests/);

  const commandCenterSource = readFileSync("src/lib/admin/command-center.ts", "utf8");
  assert.match(commandCenterSource, /platformMetrics\.leave\.pendingRequests/);

  const dataHealthSource = readFileSync("src/lib/admin/service.ts", "utf8");
  assert.match(dataHealthSource, /buildVacationPlatformMetrics/);
  assert.match(dataHealthSource, /leavePendingRequests/);
}
