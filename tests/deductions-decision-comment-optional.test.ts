// The comment on a Deductions decision is OPTIONAL.
//
// Owner, 2026-11-09: "in deductions module make comment for decision optional". Until then a decision
// with an empty comment was refused in three places — recordDecision's own validation, a CHECK on
// public.deductions_decisions, and the Decide box / bulk bar on /admin/deductions — so the reviewer
// had to type something (or the screen typed "Approved for payroll after review" for him).
//
// WHAT MUST STAY TRUE. All three doors accept a blank comment together: relaxing the screen alone
// would send a request the server refuses, and relaxing the server alone would leave the database
// refusing the row. The leave-balance comment ("Deduct from leave balance") is a DIFFERENT owner
// ruling (2026-10-09, the comment is required) and is deliberately not covered here.

import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SERVICE = "src/lib/deductions/service.ts";
const WORKSPACE = "src/components/admin/deductions-workspace.tsx";
const MIGRATIONS = "supabase/migrations";
const DROP_MIGRATION = "20261109031727_deductions_decision_comment_optional.sql";
const CONSTRAINT_NAMES = [
  "deductions_decisions_reason_required_when_decided",
  "deduction_decisions_reason_required_when_decided",
];

function read(relative: string) {
  return readFileSync(path.join(ROOT, relative), "utf8").replace(/\r\n/g, "\n");
}

function stripLineComments(source: string) {
  return source
    .split("\n")
    .map((line) => line.replace(/^\s*\/\/.*$/, "").replace(/^\s*--.*$/, ""))
    .join("\n");
}

export function runDeductionsDecisionCommentOptionalTests() {
  // 1. recordDecision: no refusal of a blank decisionReason.
  const service = read(SERVICE);
  const start = service.indexOf("export async function recordDecision(");
  assert.ok(start > 0, `${SERVICE}: recordDecision is gone.`);
  const end = service.indexOf("\nexport ", start + 10);
  const body = stripLineComments(service.slice(start, end > start ? end : undefined));
  assert.ok(
    !/decisionReason\.trim\(\)\)\s*\{\s*throw/.test(body) && !/decisionReason is required/.test(body),
    `${SERVICE}: recordDecision refuses a decision with an empty comment again. The comment is optional (owner, 2026-11-09).`,
  );
  assert.ok(
    /decision_reason:\s*input\.decisionStatus === "Pending" \? "" : input\.decisionReason\.trim\(\)/.test(body),
    `${SERVICE}: a blank comment must be stored as '' (trimmed), which the portal renders as no HR answer.`,
  );

  // 2. The database: the CHECK is dropped, and no later migration adds it back.
  const files = readdirSync(path.join(ROOT, MIGRATIONS)).filter((name) => name.endsWith(".sql")).sort();
  assert.ok(files.includes(DROP_MIGRATION), `${MIGRATIONS}/${DROP_MIGRATION} is missing.`);
  const drop = stripLineComments(read(`${MIGRATIONS}/${DROP_MIGRATION}`));
  for (const name of CONSTRAINT_NAMES) {
    assert.ok(
      new RegExp(`drop constraint if exists ${name}\\b`).test(drop),
      `${DROP_MIGRATION}: it no longer drops ${name}, so the database still refuses a decision with no comment.`,
    );
  }
  for (const later of files.filter((name) => name > DROP_MIGRATION)) {
    const sql = stripLineComments(read(`${MIGRATIONS}/${later}`));
    for (const name of CONSTRAINT_NAMES) {
      assert.ok(
        !new RegExp(`add constraint ${name}\\b`, "i").test(sql),
        `${later}: re-adds ${name}. The comment on a deductions decision is optional (owner, 2026-11-09).`,
      );
    }
  }

  // 3. The screen: neither the single Decide box nor the bulk bar blocks an empty comment.
  const workspace = read(WORKSPACE);
  const code = stripLineComments(workspace);
  assert.ok(
    !/A decision reason is required/.test(code),
    `${WORKSPACE}: the Decide box or the bulk bar refuses an empty comment again.`,
  );
  assert.ok(
    !/Approved for payroll after review/.test(code),
    `${WORKSPACE}: the screen invents a comment for a blank approval again — a blank comment is saved blank.`,
  );
  assert.ok(
    /placeholder="Comment \(optional\)"/.test(workspace) &&
      /placeholder="Comment \(optional, applied to all selected\)"/.test(workspace),
    `${WORKSPACE}: the decision comment box no longer says it is optional.`,
  );
}
