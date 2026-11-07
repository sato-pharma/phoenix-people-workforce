import assert from "node:assert/strict";
import { join } from "node:path";

import {
  capturedWorkloadColumns,
  isWorkloadRestampCandidate,
  restampWindowStart,
  shouldRestampWorkload,
  storedWorkloadTotal,
  SYSTEM_WORKLOAD_SOURCE,
  WORKLOAD_RESTAMP_WINDOW_DAYS,
} from "../src/lib/outstation/workload-stamp.ts";
import { outstationWorkloadSourceLabel } from "../src/lib/outstation/workload-source-label.ts";
import { readFileSync } from "node:fs";
import { stripComments } from "./support/comment-strip.ts";
import { cachedReadFile } from "./support/source-corpus.ts";

// A trip's workload stamped before the day's visits were typed is refreshed the next morning
// (owner, 2026-10-22: "fix the stale no-activity stamp").
//
// THE HOLE. The AM · PM · Pharmacies figures are read from the CRM the moment the departure photo
// lands — usually before the manager has typed the day's visits. Osama Mohamed El-said's 7 Oct
// Assiut trip was stamped "no activity, 0 / 0" at 19:22 Cairo; his nine visits were saved between
// 22:26 and 22:33. Nothing read it again: the workload gate already said "complete", and the one
// repair accepts `pending_workload` alone. 23 undecided claims sat stamped zero when found.
//
// WHY THE SHAPE. The rules are driven by behaviour; the job's database write cannot run here (no
// module mocking), so the guards that make it safe — undecided only, never moving money or the
// approval revision, pinned to the figures it read — are pinned on comment-stripped source.

const ROOT = process.cwd();
const SERVICE = "src/lib/outstation/service.ts";
const DAILY = "app/api/notifications/daily/route.ts";

function code(relative: string): string {
  return stripComments(cachedReadFile(join(ROOT, relative)));
}

function functionSlice(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `${signature} must exist - this test is pinned to it by name`);
  const rest = source.slice(start + signature.length);
  const next = rest.search(/\n(?:export )?(?:async )?function /);
  return rest.slice(0, next === -1 ? rest.length : next);
}

const TODAY = "2026-10-22";

function stamped(overrides: Record<string, unknown> = {}) {
  return {
    status: "submitted",
    tripEndDate: "2026-10-07",
    workloadGateStatus: "complete",
    workloadMatchStatus: "no_activity",
    workloadSource: SYSTEM_WORKLOAD_SOURCE,
    ...overrides,
  };
}

export function runOutstationWorkloadRestampTests() {
  // -- the stamp names Phoenix CRM since iReports360 was retired (6 Nov 2026) ----------------------
  assert.equal(SYSTEM_WORKLOAD_SOURCE, "phoenix_crm", "a new stamp names the source the figures came from");
  assert.equal(
    isWorkloadRestampCandidate(stamped({ workloadSource: "ireports360" }), TODAY),
    true,
    "a claim stamped before the retirement is still the system's own, so the morning re-read still owns it",
  );
  assert.equal(isWorkloadRestampCandidate(stamped({ workloadSource: "override" }), TODAY), false, "a figure an administrator typed is never re-read");
  assert.equal(outstationWorkloadSourceLabel("phoenix_crm"), "Phoenix CRM");
  assert.equal(outstationWorkloadSourceLabel("ireports360"), "iReports360 (before Phoenix CRM)");
  assert.equal(outstationWorkloadSourceLabel(null), "Manual", "no stamp reads as manual, never blank");
  assert.ok(
    readFileSync("supabase/migrations/20261107010725_outstation_workload_source_phoenix_crm.sql", "utf8").includes(
      "array['manual'::text, 'double_visit_import'::text, 'ireports360'::text, 'phoenix_crm'::text, 'override'::text]",
    ),
    "the column's check accepts the new stamp and keeps every old one",
  );

  // -- who is re-read ------------------------------------------------------------------------------
  assert.equal(
    isWorkloadRestampCandidate(stamped(), TODAY),
    true,
    "HEADLINE: Osama's 7 Oct trip — undecided, stamped by the system, finished — is re-read the next morning",
  );
  assert.equal(isWorkloadRestampCandidate(stamped({ status: "needs_review" }), TODAY), true);
  for (const decided of ["accepted_by_admin", "accepted_by_system", "rejected_by_admin", "approved"]) {
    assert.equal(
      isWorkloadRestampCandidate(stamped({ status: decided }), TODAY),
      false,
      `a ${decided} claim is never re-read — the approver may have acted on the figure he saw`,
    );
  }
  assert.equal(
    isWorkloadRestampCandidate(stamped({ workloadGateStatus: "manual" }), TODAY),
    false,
    "a workload a Super Admin typed is never overwritten",
  );
  assert.equal(
    isWorkloadRestampCandidate(stamped({ workloadSource: "override" }), TODAY),
    false,
    "an override source is never overwritten",
  );
  assert.equal(
    isWorkloadRestampCandidate(stamped({ workloadMatchStatus: "manual_override" }), TODAY),
    false,
    "a manual_override verdict is never overwritten",
  );
  assert.equal(
    isWorkloadRestampCandidate(stamped({ workloadGateStatus: "pending_workload" }), TODAY),
    false,
    "a trip still waiting for its first stamp is stamped at its departure photo, not here",
  );
  assert.equal(
    isWorkloadRestampCandidate(stamped({ workloadSource: "double_visit_import" }), TODAY),
    false,
    "only the system's own CRM read is refreshed",
  );
  assert.equal(
    isWorkloadRestampCandidate(stamped({ tripEndDate: TODAY }), TODAY),
    false,
    "a trip whose last day is today is still collecting visits",
  );
  assert.equal(isWorkloadRestampCandidate(stamped({ tripEndDate: "2026-10-21" }), TODAY), true, "yesterday's trip is re-read");
  assert.equal(restampWindowStart(TODAY), "2026-09-07", "the window is 45 calendar days");
  assert.equal(WORKLOAD_RESTAMP_WINDOW_DAYS, 45);
  assert.equal(isWorkloadRestampCandidate(stamped({ tripEndDate: "2026-09-07" }), TODAY), true, "the window's first day is inside it");
  assert.equal(isWorkloadRestampCandidate(stamped({ tripEndDate: "2026-09-06" }), TODAY), false, "older than the window is left alone");
  assert.equal(isWorkloadRestampCandidate(stamped({ tripEndDate: "" }), TODAY), false, "no trip end, no re-read");
  assert.equal(isWorkloadRestampCandidate(stamped({ tripEndDate: "not a date" }), TODAY), false);

  // -- only upwards ----------------------------------------------------------------------------------
  const zero = { amWorkload: 0, pharmacyWorkload: 0, pmWorkload: 0 };
  assert.equal(
    shouldRestampWorkload(zero, { amWorkload: 0, pharmacyWorkload: 0, pmWorkload: 9 }),
    true,
    "HEADLINE: nine visits saved after a zero stamp replace it",
  );
  assert.equal(shouldRestampWorkload(zero, zero), false, "an equal read is a no-op — a correct stamp is never touched");
  assert.equal(
    shouldRestampWorkload({ amWorkload: 3, pharmacyWorkload: 2, pmWorkload: 4 }, { amWorkload: 3, pharmacyWorkload: 0, pmWorkload: 4 }),
    false,
    "a LOWER live figure is a question for a person, never a quiet rewrite",
  );
  assert.equal(
    shouldRestampWorkload({ amWorkload: 2, pharmacyWorkload: null, pmWorkload: 1 }, { amWorkload: 2, pharmacyWorkload: 1, pmWorkload: 1 }),
    true,
    "a missing third figure counts as none",
  );
  assert.equal(storedWorkloadTotal({ amWorkload: -4, pharmacyWorkload: null, pmWorkload: 2 }), 2, "a negative never subtracts");

  // -- the one stamp shape ---------------------------------------------------------------------------
  const capture = {
    amWorkload: 0,
    captured: true as const,
    contributingHrIds: ["PD-0014"],
    days: [],
    hops: 0,
    pharmacyWorkload: 0,
    pmWorkload: 9,
    sourceLabel: "Phoenix CRM",
  };
  const fresh = capturedWorkloadColumns(capture, "2026-10-08T04:36:00.000Z");
  assert.equal(fresh.workload_match_status, "matched", "nine visits read as matched, never no_activity beside them");
  assert.equal(fresh.workload_source, SYSTEM_WORKLOAD_SOURCE);
  assert.equal(fresh.pm_workload, 9);
  assert.ok(!("refreshedFrom" in fresh.workload_evidence_snapshot), "a first stamp records no previous one");
  const refreshed = capturedWorkloadColumns(capture, "2026-10-08T04:36:00.000Z", {
    amWorkload: 0,
    matchedAt: "2026-10-07T16:22:06.000Z",
    pharmacyWorkload: 0,
    pmWorkload: 0,
  });
  assert.deepEqual(
    (refreshed.workload_evidence_snapshot as { refreshedFrom?: unknown }).refreshedFrom,
    { amWorkload: 0, matchedAt: "2026-10-07T16:22:06.000Z", pharmacyWorkload: 0, pmWorkload: 0 },
    "a refresh records the stamp it replaced, so the approver can see the figure moved and from what",
  );
  for (const forbidden of ["updated_at", "workload_gate_status", "approval_reason", "claimed_total_amount", "expected_total_amount"]) {
    assert.ok(!(forbidden in refreshed), `the stamp shape never writes ${forbidden}`);
  }

  // -- the job's guards, on source -------------------------------------------------------------------
  const service = code(SERVICE);
  const job = functionSlice(service, "export async function runOutstationWorkloadRestamp(");
  assert.match(job, /isWorkloadRestampCandidate\(/, "the job filters through the candidate rule");
  assert.match(job, /shouldRestampWorkload\(request, capture\)/, "and writes only an upward read");
  assert.match(job, /\.in\("status", \[\.\.\.OUTSTATION_UNDECIDED_STATUSES\]\)[\s\S]*\.in\("status", \[\.\.\.OUTSTATION_UNDECIDED_STATUSES\]\)/, "the read AND the write are pinned to undecided claims");
  assert.match(job, /\.eq\("am_workload", request\.amWorkload\)/, "the write is pinned to the figures that were read");
  assert.match(job, /\.in\("workload_source", \[\.\.\.SYSTEM_WORKLOAD_SOURCES\]\)/, "a figure typed by hand in between is never overwritten");
  assert.doesNotMatch(job, /updated_at/, "the approval revision belongs to money — a refresh never bumps it");
  assert.doesNotMatch(job, /workload_gate_status:/, "the gate status is never rewritten");
  assert.match(job, /writeRequiredAuditLog\(/, "every refresh leaves an audit row");
  assert.match(job, /WORKLOAD_RESTAMP_MAX_ROWS/, "one run is capped");
  const first = functionSlice(service, "async function captureWorkloadAndReleaseIfReady(");
  assert.match(first, /capturedWorkloadColumns\(capture, now\)/, "the first stamp and the refresh share one shape");

  const daily = code(DAILY);
  assert.match(daily, /runOutstationWorkloadRestamp\(\)\.catch\(\s*onJobFailure\("daily-outstation-workload-restamp"/, "it runs every morning in the daily job, with its own catch");
  const destructure = daily.slice(daily.indexOf("  const ["), daily.indexOf("] = await Promise.all(["));
  assert.ok(
    destructure.indexOf("outstationWorkloadRestamp") > destructure.indexOf("probationMilestoneEmails"),
    "appended after position 30, so positions 1-30 keep their meaning",
  );
}
