import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  selectStrandedAcceptedClaims,
  STRANDED_RELEASE_MAX_PER_RUN,
  type StrandedReleaseCandidate,
} from "../src/lib/outstation/stranded-release.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// An accepted outstation claim is never stranded off payroll (claims 111 and 347, 21 Nov 2026).
//
// Two District Managers' accepted claims — EGP 320 and EGP 775 — had every gate complete and no payroll row. The
// release that follows their own departure photo ran under THEIR access, the payroll save asked them for expense-
// approval rights a District Manager does not hold ("Forbidden: District Manager cannot approve expenses"), and after
// the departure photo nothing ever tried again. Pinned here:
//   (a) the automatic release runs as the system, never as whoever made the capture;
//   (b) the morning departure-photo job retries every accepted claim the gate clears that no payroll row carries;
//   (c) which claims that retry may touch — accepted only, gate-cleared only, no payroll row at all, a bounded batch.
// ─────────────────────────────────────────────────────────────────────────────

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

/** The body of one top-level function, from its signature to the next top-level declaration. */
function topLevelBlock(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `could not find ${signature}`);
  const rest = source.slice(start + signature.length);
  const next = rest.search(/\n(?:export )?(?:async )?(?:function|const|type|class) /);
  return source.slice(start, start + signature.length + (next < 0 ? rest.length : next));
}

function claim(overrides: Partial<StrandedReleaseCandidate> & { id: number }): StrandedReleaseCandidate {
  return {
    carEvidenceImagePath: "outstation/arrival.jpg",
    departureEvidenceImagePath: "outstation/departure.jpg",
    employeeRole: "District Manager",
    evidenceGateStatus: "complete",
    status: "accepted_by_admin",
    workloadGateStatus: "complete",
    ...overrides,
  };
}

export function runOutstationStrandedReleaseTests() {
  // ── (a) the automatic release runs as the system ──────────────────────────────────────────────
  const service = stripComments(read("src/lib/outstation/service.ts"));
  const automatic = topLevelBlock(service, "async function runAutomaticOutstationRelease(");
  assert.match(
    automatic,
    /releaseOutstationRequestToPayrollIfReady\(request\.id, systemAccessContext\)/,
    "the release after an employee's own capture runs as the system: the claim was already accepted, and the employee " +
      "holds no expense-approval rights of their own (a District Manager's capture was refused and stranded the money)",
  );
  assert.doesNotMatch(
    automatic.slice(0, automatic.indexOf("{")),
    /access/,
    "runAutomaticOutstationRelease takes no caller access, so no caller can hand it theirs again",
  );
  const capture = topLevelBlock(service, "async function captureWorkloadAndReleaseIfReady(");
  assert.doesNotMatch(capture.slice(0, capture.indexOf("{")), /access/, "the capture's follow-on takes no caller access either");

  // ── (b) the morning job retries a stranded claim, through the same release, as the system ─────
  const sweep = topLevelBlock(service, "export async function releaseStrandedAcceptedOutstationClaims(");
  assert.match(sweep, /selectStrandedAcceptedClaims\(/, "the retry chooses its claims with the pure selector pinned below");
  assert.match(
    sweep,
    /releaseOutstationRequestToPayrollIfReady\(request\.id, systemAccessContext\)/,
    "the retry hands each claim to the SAME release, as the system — never a second write path for the money",
  );
  assert.match(sweep, /\.like\("status", "accepted%"\)/, "the retry reads accepted claims only");
  assert.match(sweep, /if \(error\) throw new Error\(error\.message\)/, "an unread payroll table throws — never 'nothing was stranded'");

  const runners = stripComments(read("app/api/cron/daily/_lib/daily-job-runners.ts"));
  const departureJob = runners.slice(
    runners.indexOf('"outstation-departure-photo": {'),
    runners.indexOf('"resignation-sla": {'),
  );
  assert.match(
    departureJob,
    /releaseStrandedAcceptedOutstationClaims\(\)\.catch\(\(error: unknown\) => \{\s*logError\(/,
    "the morning departure-photo job runs the retry, and a failed retry is logged as an ERROR, never swallowed",
  );
  assert.equal(
    (departureJob.match(/\.catch\(\s*onJobFailure\(/g) ?? []).length,
    1,
    "the job stays ONE guarded pass — each morning job is exactly one (tests/dead-telegram-link-alert.test.ts)",
  );

  // ── (c) which claims the retry may touch ───────────────────────────────────────────────────────
  const stranded = claim({ id: 111 });
  const queued = claim({ id: 120 });
  const submitted = claim({ id: 130, status: "submitted" });
  const rejected = claim({ id: 131, status: "rejected_by_admin" });
  const waitingForPhoto = claim({
    departureEvidenceImagePath: null,
    evidenceGateStatus: "pending_departure_photo",
    id: 162,
    workloadGateStatus: "pending_workload",
  });
  const waitingForWorkload = claim({ id: 163, workloadGateStatus: "pending_workload" });
  const claimsCompleteButHasNoPhoto = claim({ departureEvidenceImagePath: null, id: 164 });
  const systemAccepted = claim({ id: 347, status: "accepted_by_system" });

  const picked = selectStrandedAcceptedClaims(
    [systemAccepted, queued, submitted, rejected, waitingForPhoto, waitingForWorkload, claimsCompleteButHasNoPhoto, stranded],
    new Set(["OUTSTATION-120"]),
  );
  assert.deepEqual(
    picked.map((request) => request.id),
    [111, 347],
    "only an accepted claim the gate clears and no payroll row carries is retried — a claim with a row (queued or paid), " +
      "an undecided or rejected claim, one still waiting for its photo or workload, and one whose stored status claims " +
      "a photo it does not have are all left alone; lowest id first",
  );

  const backlog = Array.from({ length: STRANDED_RELEASE_MAX_PER_RUN + 5 }, (_, index) => claim({ id: 1000 + index }));
  assert.equal(
    selectStrandedAcceptedClaims(backlog, new Set()).length,
    STRANDED_RELEASE_MAX_PER_RUN,
    "a surprise backlog is released a bounded batch a morning, never in one burst",
  );
}
