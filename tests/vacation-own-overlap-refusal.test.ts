import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { findOwnLeaveOverlap, ownLeaveOverlapMessage, type OwnLeaveOverlapCandidate } from "../src/lib/vacation/service.ts";

/**
 * ONE PERSON, ONE LIVE REQUEST PER DAY (owner, 2026-11-17, from the Ragaa audit). VAC-0647
 * (3 Oct to 7 Nov) and VAC-0729 (1 to 15 Nov) were both live for the same person; approval priced
 * each on its own, so 1 to 7 Nov was counted twice and the first approval took the whole paid sick
 * allowance. A new or resubmitted request that touches the same person's own in-flight or approved
 * request is refused.
 */

function row(overrides: Partial<OwnLeaveOverlapCandidate> & Pick<OwnLeaveOverlapCandidate, "id" | "startDate" | "endDate">): OwnLeaveOverlapCandidate {
  return { dayPart: "full_day", requestCode: null, status: "pending_manager", ...overrides };
}

function serviceFunctionBody(source: string, signature: string) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} must exist in service.ts`);
  const next = source.slice(start + signature.length).search(/\n(export )?async function /);
  return next < 0 ? source.slice(start) : source.slice(start, start + signature.length + next);
}

export function runVacationOwnOverlapRefusalTests() {
  // 1. The Ragaa case: a sick request 1 to 15 Nov against her own pending 3 Oct to 7 Nov.
  {
    const existing = [row({ id: "vac-0647", requestCode: "VAC-0647", startDate: "2026-10-03", endDate: "2026-11-07" })];
    const hit = findOwnLeaveOverlap({ candidate: { dayPart: "full_day", startDate: "2026-11-01", endDate: "2026-11-15" }, existing });
    assert.equal(hit?.id, "vac-0647", "a request overlapping the person's own pending leave must be refused");
    const message = ownLeaveOverlapMessage(hit!);
    assert.match(message, /VAC-0647/, "the refusal names the request it collides with");
    assert.match(message, /2026-10-03 to 2026-11-07/, "the refusal names that request's dates");
    assert.match(ownLeaveOverlapMessage(hit!, "admin"), /^This employee already has leave VAC-0647/, "an admin reads about the employee, not 'you'");
  }

  // 2. Every live status blocks: the three in-flight ones and approved.
  for (const status of ["needs_assignment", "pending_manager", "pending_hr", "approved"]) {
    const existing = [row({ id: `live-${status}`, startDate: "2026-12-01", endDate: "2026-12-03", status })];
    const hit = findOwnLeaveOverlap({ candidate: { dayPart: "full_day", startDate: "2026-12-03", endDate: "2026-12-05" }, existing });
    assert.equal(hit?.id, `live-${status}`, `${status} is live, so touching its last day is an overlap`);
  }

  // 3. Dead statuses never block: returned, rejected and cancelled.
  for (const status of ["returned", "rejected", "cancelled"]) {
    const existing = [row({ id: `dead-${status}`, startDate: "2026-12-01", endDate: "2026-12-03", status })];
    const hit = findOwnLeaveOverlap({ candidate: { dayPart: "full_day", startDate: "2026-12-02", endDate: "2026-12-02" }, existing });
    assert.equal(hit, null, `${status} is not live and must not block`);
  }

  // 4. Back-to-back is not an overlap: the day after the existing one ends is free.
  {
    const existing = [row({ id: "before", startDate: "2026-10-03", endDate: "2026-11-07" })];
    const hit = findOwnLeaveOverlap({ candidate: { dayPart: "full_day", startDate: "2026-11-08", endDate: "2026-11-15" }, existing });
    assert.equal(hit, null, "a request starting the day after the existing one ends must pass");
  }

  // 5. A resubmitted request never collides with itself.
  {
    const existing = [row({ id: "self", startDate: "2026-12-01", endDate: "2026-12-03", status: "approved" })];
    const hit = findOwnLeaveOverlap({ candidate: { dayPart: "full_day", startDate: "2026-12-01", endDate: "2026-12-03" }, excludeRequestId: "self", existing });
    assert.equal(hit, null, "the request being resubmitted or edited is excluded from its own check");
  }

  // 6. AM-only and PM-only on the same single day are two halves of one day, not an overlap;
  //    the same half twice, or a half against a full day, is.
  {
    const am = [row({ id: "am", dayPart: "am_only", startDate: "2026-12-10", endDate: "2026-12-10" })];
    assert.equal(findOwnLeaveOverlap({ candidate: { dayPart: "pm_only", startDate: "2026-12-10", endDate: "2026-12-10" }, existing: am }), null, "PM beside AM on one day passes");
    assert.equal(findOwnLeaveOverlap({ candidate: { dayPart: "am_only", startDate: "2026-12-10", endDate: "2026-12-10" }, existing: am })?.id, "am", "AM twice on one day is refused");
    assert.equal(findOwnLeaveOverlap({ candidate: { dayPart: "full_day", startDate: "2026-12-10", endDate: "2026-12-10" }, existing: am })?.id, "am", "a full day over a half day is refused");
  }

  // 7. Wiring: every path that writes a live request runs the refusal before it writes.
  {
    const source = readFileSync(path.join(process.cwd(), "src/lib/vacation/service.ts"), "utf8");
    for (const signature of [
      "export async function createVacationRequest(",
      "export async function resubmitVacationRequest(",
      "async function buildAdminVacationMutationPayload(",
    ]) {
      assert.match(serviceFunctionBody(source, signature), /await assertNoOwnLeaveOverlap\(\{/, `${signature} must call assertNoOwnLeaveOverlap`);
    }
    const create = serviceFunctionBody(source, "export async function createVacationRequest(");
    assert.ok(
      create.indexOf("await assertNoOwnLeaveOverlap({") < create.indexOf(".insert({"),
      "the employee's request is checked before it is inserted",
    );
  }
}
