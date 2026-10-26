// Owner audit, 2026-10-26: 85 manager and 77 HR decisions on leave requests in production held the
// decider's HR number in lower case ("b-118" instead of "B-118"), so a name lookup or a "decided by
// me" filter that compares the stored text missed them.
//
// The cause was one call. The decision flow handed `resolveEmployeeIdentityId(access)` to the
// writers, and that returns the LOWERCASE comparison key — right for matching, wrong for storing.
// `hrIdForStorage` is the stored form, and #2946 moved 31 sites onto it, but the vacation decision
// path wrote `actorHrId: resolveEmployeeIdentityId(access),` with no `??` after it, which is the only
// shape the repo-wide pin (`tests/hr-id-storage-casing.test.ts`, its RAW_ACTOR pattern) can see.
//
// The writers sit behind a database, so they are source-pinned, exactly like their sibling pin:
//   1. the one helper stores the HR id upper-case and keeps the login-id fallback untouched;
//   2. the decision entry and the admin-recorded decision both go through it;
//   3. the stalled-approver override column goes through hrIdForStorage — it used to go through the
//      access-key canonicaliser, which strips the hyphen too ("b10") and left one such row;
//   4. the repair migration is idempotent and touches only the two decision columns.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments, stripSqlComments } from "./support/comment-strip.ts";
import { hrIdForStorage } from "../src/lib/hr-id.ts";

function functionBody(source: string, declaration: string) {
  const start = source.indexOf(declaration);
  assert.notEqual(start, -1, `${declaration} must exist — the test is pinning a function that was renamed or removed`);

  let parens = 0;
  let cursor = start;
  let sawParams = false;
  for (; cursor < source.length; cursor += 1) {
    if (source[cursor] === "(") {
      parens += 1;
      sawParams = true;
    } else if (source[cursor] === ")") {
      parens -= 1;
      if (sawParams && parens === 0) {
        cursor += 1;
        break;
      }
    }
  }
  const bodyStart = source.indexOf("{", cursor);
  assert.notEqual(bodyStart, -1, `Could not find the body of ${declaration}`);

  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart, i + 1);
    }
  }
  throw new Error(`Could not find the end of ${declaration}`);
}

export function runVacationDeciderHrIdStorageTests() {
  // The stored form itself, exercised for real: the lowercase key becomes the HR number as filed.
  assert.equal(hrIdForStorage("b-118"), "B-118");
  assert.equal(hrIdForStorage("ai-0008"), "AI-0008");
  assert.equal(hrIdForStorage(null), null);

  const service = stripComments(readFileSync("src/lib/vacation/service.ts", "utf8"));

  // 1. The helper upper-cases ONLY the HR id; the login-id fallback is left exactly as it was.
  const helper = functionBody(service, "function resolveStoredDeciderHrId(");
  assert.match(
    helper,
    /return\s+hrIdForStorage\(access\.hrId\)\s*\?\?\s*resolveEmployeeIdentityId\(access\)\s*;/,
    "the decider's HR id must be stored through hrIdForStorage(access.hrId), with the login-id fallback behind it",
  );

  // 2. Both places that put a decider's HR id on a request go through the helper.
  const decide = functionBody(service, "export async function decideVacationRequest(");
  assert.match(
    decide,
    /actorHrId:\s*resolveStoredDeciderHrId\(access\)/,
    "decideVacationRequest must hand applyVacationDecision the stored (upper-case) HR id",
  );
  assert.doesNotMatch(
    decide,
    /actorHrId:\s*resolveEmployeeIdentityId\(/,
    "decideVacationRequest must not hand the writers the lowercase comparison key — it landed 162 lowercase decider cells in production",
  );
  assert.match(
    service,
    /const actorHrId = resolveStoredDeciderHrId\(input\.access\);\s*const decisionPayload = adminDecisionPayload\(/,
    "an admin-recorded decision must store the decider's HR id through the same helper",
  );

  // 3. The override column no longer uses the hyphen-stripping access key.
  const stepDecision = functionBody(service, "async function recordVacationApprovalStepDecision(");
  assert.match(
    stepDecision,
    /const overriddenByHrId = hrIdForStorage\(input\.overriddenByHrId\) \|\| null;/,
    "overridden_by_hr_id must be stored through hrIdForStorage",
  );
  assert.doesNotMatch(
    stepDecision,
    /overriddenByHrId = canonicalHrId\(/,
    "canonicalHrId strips the hyphen and lower-cases — it is a comparison key, never a stored value",
  );

  // 4. The repair migration upper-cases exactly the two decision columns, and only the rows still wrong.
  const statements = stripSqlComments(
    readFileSync("supabase/migrations/20261026150000_vacation_decider_hr_id_upper_case.sql", "utf8"),
  );
  for (const column of ["manager_decision_by_hr_id", "hr_decision_by_hr_id"]) {
    assert.match(
      statements,
      new RegExp(`set ${column} = upper\\(${column}\\)[\\s\\S]*?and ${column} <> upper\\(${column}\\);`),
      `the migration must upper-case ${column} only where it is still lower case`,
    );
  }
  assert.equal((statements.match(/\bupdate\b/gi) ?? []).length, 2, "the migration is exactly two UPDATEs");
  assert.doesNotMatch(statements, /\b(delete|drop|truncate|alter)\b/i, "the repair is data only");
}
