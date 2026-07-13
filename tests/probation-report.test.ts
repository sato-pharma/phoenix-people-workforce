import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { DEFAULT_PROBATION_CONFIG } from "../src/lib/probation/intelligence/config.ts";
import {
  currentProbationDay,
  milestoneStatuses,
  computeDvProgress,
  PROBATION_MILESTONE_DAYS,
  type DvDayLite,
} from "../src/lib/probation/intelligence/report-metrics.ts";

function src(p: string) { return readFileSync(p, "utf8"); }

export function runProbationReportTests() {
  // Milestone schedule is fixed at 30/60/75 (must not change).
  assert.deepEqual([...PROBATION_MILESTONE_DAYS], [30, 60, 75]);

  // ── P7-T02 current day + milestones ──
  // Hired 2026-05-01; on 2026-05-30 that is day 30.
  assert.equal(currentProbationDay("2026-05-01", "2026-05-30"), 30);
  assert.equal(currentProbationDay(null, "2026-05-30"), null);

  const ms = milestoneStatuses("2026-05-01", "2026-05-30");
  const byDay = Object.fromEntries(ms.map((m) => [m.day, m]));
  assert.equal(byDay[30].reached, true, "day 30 reached");
  assert.equal(byDay[60].reached, false, "day 60 not reached");
  assert.equal(byDay[75].reached, false, "day 75 not reached");
  assert.equal(byDay[30].date, "2026-05-30", "day-30 calendar date");
  assert.equal(byDay[75].date, "2026-07-14", "day-75 calendar date");

  // ── P7-T03 DV progress rollup ──
  const dvDays: DvDayLite[] = [
    { evaluatorRole: "dm", dvStatus: "feedback_completed" },
    { evaluatorRole: "dm", dvStatus: "feedback_completed" },
    { evaluatorRole: "dm", dvStatus: "feedback_completed" },
    { evaluatorRole: "tm", dvStatus: "validated" },
    { evaluatorRole: "nsm", dvStatus: "feedback_completed" },
    { evaluatorRole: null, dvStatus: "invalid" }, // ignored
  ];
  const prog = computeDvProgress(dvDays, DEFAULT_PROBATION_CONFIG);
  assert.equal(prog.byRole.dm.feedbackCompleted, 3);
  assert.equal(prog.byRole.dm.complete, true, "3/3 DM complete");
  assert.equal(prog.byRole.tm.validated, 1);
  assert.equal(prog.byRole.tm.feedbackCompleted, 0);
  assert.equal(prog.byRole.tm.complete, false, "TM validated but no feedback yet");
  assert.equal(prog.byRole.nsm.complete, true);
  assert.equal(prog.byRole.pm_gpm.validated, 0);
  assert.equal(prog.totalRequired, 6);
  assert.equal(prog.totalValidated, 5);
  assert.equal(prog.totalFeedbackCompleted, 4);

  // ── Report composition guarantees (source assertions) ──
  const rep = src("src/lib/probation/intelligence/consolidated-report.ts");
  // Computed on read (live), never a batch.
  assert.match(rep, /COMPUTED ON READ/i, "report is computed on read (live from day 1)");
  // Data freshness / stale flag from last CRM sync.
  assert.match(rep, /stale = lastSync/, "stale computed from last CRM sync");
  assert.match(rep, /STALE_SYNC_HOURS/, "stale threshold defined");
  // Event-sourced audit timeline from the records.
  assert.match(rep, /kind: "case_created"/, "timeline includes case creation");
  assert.match(rep, /kind: "dv_captured"/, "timeline includes DV capture");
  assert.match(rep, /kind: "feedback"/, "timeline includes feedback events");
  assert.match(rep, /timeline\.sort/, "timeline sorted chronologically");
  // Show names, not codes.
  assert.match(rep, /evaluatorNameByHrId/, "evaluator names resolved (not raw HR codes)");
  // Confidential visit comments only for HR/CEO.
  assert.match(rep, /canSeeConfidential \? v\.comment : null/, "visit comments redacted for non-HR/CEO");
  // SLA breaches surfaced from open feedback tasks.
  assert.match(rep, /slaBreaches\.push/, "SLA breaches surfaced");

  // Report API route gated on probation:read.
  const route = src("app/api/probation/cases/[caseId]/report/route.ts");
  assert.match(route, /assertPermission\(access, "probation", "read"\)/, "report route gated on probation:read");

  // Report page gated to probation readers.
  const page = src("app/(admin)/probation/cases/[caseId]/page.tsx");
  assert.match(page, /canReadAllProbation\(access\)/, "report page gated to probation readers");
}
