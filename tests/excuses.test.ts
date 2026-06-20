import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  excuseErrorMessage,
  isExcusesSchemaMissing,
  isHeadOfficeExcuseEmployee,
  parseExcuseDecision,
  parseExcuseType,
} from "../src/lib/excuses/service.ts";

export async function runExcusesTests() {
  // --- parseExcuseType: only morning/afternoon, case-insensitive, trimmed ---------------
  assert.equal(parseExcuseType("morning"), "morning");
  assert.equal(parseExcuseType("  AFTERNOON "), "afternoon");
  assert.equal(parseExcuseType("Morning"), "morning");
  assert.equal(parseExcuseType("evening"), null, "unknown excuse types must be rejected");
  assert.equal(parseExcuseType(""), null);
  assert.equal(parseExcuseType(null), null);
  assert.equal(parseExcuseType(undefined), null);

  // --- parseExcuseDecision: accepts both imperative and past-tense forms ----------------
  assert.equal(parseExcuseDecision("approve"), "approve");
  assert.equal(parseExcuseDecision("approved"), "approve");
  assert.equal(parseExcuseDecision("reject"), "reject");
  assert.equal(parseExcuseDecision("rejected"), "reject");
  assert.equal(parseExcuseDecision("  Approve "), "approve");
  assert.equal(parseExcuseDecision("maybe"), null, "unknown decisions must be rejected");
  assert.equal(parseExcuseDecision(null), null);

  // --- isHeadOfficeExcuseEmployee: head-office by line or department, fuzzy-normalized ---
  assert.equal(isHeadOfficeExcuseEmployee({ lineName: "Office", departmentName: null }), true);
  assert.equal(isHeadOfficeExcuseEmployee({ lineName: "Head Office", departmentName: null }), true);
  assert.equal(isHeadOfficeExcuseEmployee({ lineName: null, departmentName: "HQ" }), true);
  assert.equal(isHeadOfficeExcuseEmployee({ lineName: "CNS", departmentName: "Sales" }), false,
    "field/sales employees are not head-office excuse-eligible");
  assert.equal(isHeadOfficeExcuseEmployee({ lineName: null, departmentName: null }), false);

  // --- excuseErrorMessage: Error -> message, otherwise stringified safely ----------------
  assert.equal(excuseErrorMessage(new Error("boom")), "boom");
  assert.equal(excuseErrorMessage("raw string"), "raw string");
  assert.equal(excuseErrorMessage(null), "");

  // --- isExcusesSchemaMissing: recognizes a missing-table error ---------------------------
  assert.equal(
    isExcusesSchemaMissing(new Error('relation "v2_excuse_requests" does not exist')),
    true,
    "a missing excuses table must be detected so the workspace degrades gracefully",
  );
  assert.equal(isExcusesSchemaMissing(new Error("some unrelated failure")), false);

  // --- State-machine + authorization invariants (source-asserted) ------------------------
  const serviceSource = readFileSync("src/lib/excuses/service.ts", "utf8");
  // Only a pending request can be decided — guards against double-approval.
  assert.match(
    serviceSource,
    /requestRow\.status !== "pending_manager"/,
    "decideExcuseRequestByToken must reject requests that are not pending_manager",
  );
  // The approval token must be single-use, unexpired, and bound to the request's manager.
  assert.match(serviceSource, /tokenData\.used_at/, "approval token must be rejected once used");
  assert.match(serviceSource, /tokenData\.expires_at|expires_at\).getTime\(\)/, "approval token must honour expiry");
  assert.match(
    serviceSource,
    /normalizeHrId\(tokenData\.manager_hr_id\) !== normalizeHrId\(requestRow\.manager_hr_id\)/,
    "only the request's assigned manager may decide via the token link",
  );
  // After a decision, the token is burned so the link cannot be replayed.
  assert.match(
    serviceSource,
    /v2_excuse_email_tokens[\s\S]*used_at: now/,
    "the approval token must be marked used after a decision",
  );
  // Access is restricted to the eligible roles or head-office employees.
  assert.match(
    serviceSource,
    /National Sales Manager"[\s\S]*isHeadOfficeExcuseEmployee/,
    "excuses must be limited to eligible roles or head-office employees",
  );
  // Product / Group Product / Training Managers are also excuse-eligible.
  assert.match(
    serviceSource,
    /"Product Manager"[\s\S]*"Group Product Manager"[\s\S]*"Training Manager"/,
    "excuses must also be available to PM/GPM/TM",
  );
}
