import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { isActiveEmployeeHrId, resolveStoredEmployeeHrId } from "@/lib/marketing-requests/service";

function source(relPath: string): string {
  return readFileSync(relPath, "utf8");
}

function directoryRow(hrId: string): EmployeeDirectoryRow {
  // The resolver only reads `.hrId`; a partial row is enough for the unit.
  return { hrId } as unknown as EmployeeDirectoryRow;
}

/**
 * Regression guard for the marketing approval-chain HR_ID casing bug.
 *
 * The marketing approval tables foreign-key `assigned_hr_id` and `decision_by_hr_id` to
 * `employees(hr_id)`, which is case-sensitive and stored UPPER-cased. The app's
 * `normalizeHrId()` lower-cases for comparison; writing that lower-cased value ("a-9")
 * against an upper-cased parent ("A-9") raised a foreign-key violation (SQLSTATE 23503)
 * that aborted EVERY marketing submit and decision in production — which the broad draft
 * error mapper then mislabelled as "schema is not applied". With submits rolled back,
 * 0 requests persisted, so the approver inbox was also silently empty.
 *
 * This suite pins the fix end to end: the resolver dialect, the resolved writes, the
 * case-tolerant inbox reads, and the honest (non-masking) error mapper.
 */
export async function runMarketingApproverHrIdCasingTests() {
  // ── resolveStoredEmployeeHrId resolves every dialect to the employee master casing ──
  const directory = new Map<string, EmployeeDirectoryRow>([
    ["a-9", directoryRow("A-9")],
    ["b-23", directoryRow("B-23")],
    // A genuinely lower-cased master row must be honoured EXACTLY, never blindly upper-cased.
    ["c-o1", directoryRow("c-o1")],
  ]);

  // Directory present → exact stored casing, regardless of the input dialect.
  assert.equal(resolveStoredEmployeeHrId("a-9", directory), "A-9");
  assert.equal(resolveStoredEmployeeHrId("A-9", directory), "A-9");
  assert.equal(resolveStoredEmployeeHrId("  a-9  ", directory), "A-9");
  assert.equal(resolveStoredEmployeeHrId("b-23", directory), "B-23");
  assert.equal(resolveStoredEmployeeHrId("C-O1", directory), "c-o1");

  // Not in the directory map → canonical upper-case fallback (master is upper-cased).
  assert.equal(resolveStoredEmployeeHrId("z-1", directory), "Z-1");

  // No directory at all → canonical upper-case fallback, including the alias map.
  assert.equal(resolveStoredEmployeeHrId("a-9"), "A-9");
  assert.equal(resolveStoredEmployeeHrId("AA"), "AA");
  assert.equal(resolveStoredEmployeeHrId("aaa"), "AA"); // alias: aaa → aa → AA

  // Empty / nullish → null (never write a spurious FK value).
  assert.equal(resolveStoredEmployeeHrId("", directory), null);
  assert.equal(resolveStoredEmployeeHrId("   "), null);
  assert.equal(resolveStoredEmployeeHrId(null), null);
  assert.equal(resolveStoredEmployeeHrId(undefined), null);

  /**
   * Regression guard for the resigned-`direct_manager`-approver bug: a marketing
   * approval step scoped to "direct_manager" resolves its gating approver straight from
   * the request's stored `manager_hr_id`, with no active-employee filtering upstream.
   * `pushRow` is meant to fail loudly when that approver "is not a current employee" —
   * but `resolveStoredEmployeeHrId` alone can't detect that: it deliberately still
   * returns a display-cased fallback HR_ID when the id is absent from the (active-only)
   * `byHrId` map, which is exactly the resigned-employee case. `isActiveEmployeeHrId`
   * checks directory membership directly, independent of that fallback.
   */
  assert.equal(isActiveEmployeeHrId("a-9", directory), true);
  assert.equal(isActiveEmployeeHrId("A-9", directory), true);
  assert.equal(isActiveEmployeeHrId("  a-9  ", directory), true);
  // Not in the directory map (e.g. a resigned direct_manager) → false, even though
  // resolveStoredEmployeeHrId still returns a plausible-looking fallback for the same input.
  assert.equal(isActiveEmployeeHrId("z-1", directory), false);
  assert.equal(resolveStoredEmployeeHrId("z-1", directory), "Z-1");
  assert.equal(isActiveEmployeeHrId("z-1"), false); // no directory map at all
  assert.equal(isActiveEmployeeHrId(""), false);
  assert.equal(isActiveEmployeeHrId("   "), false);
  assert.equal(isActiveEmployeeHrId(null), false);
  assert.equal(isActiveEmployeeHrId(undefined), false);

  // ── Source-pinned guarantees so a refactor cannot silently regress the FK fix ──
  const service = source("src/lib/marketing-requests/service.ts");

  // 1. Approval steps store the RESOLVED stored HR_ID, never the raw (lower-cased) input.
  assert.match(
    service,
    /const storedHrId = resolveStoredEmployeeHrId\(input\.assignedHrId, byHrId\)/,
    "pushRow must resolve the approver to the employee-master casing before insert",
  );
  assert.match(
    service,
    /assigned_hr_id: storedHrId/,
    "createMarketingApprovalSteps must write the resolved stored HR_ID into assigned_hr_id",
  );
  // A gating approver who is not a current employee fails loudly (not a silent FK abort).
  assert.match(
    service,
    /marketing_approver_not_employee/,
    "a non-employee gating approver must throw a named, actionable error",
  );
  // The gate must independently verify ACTIVE status — resolveStoredEmployeeHrId's return
  // value alone cannot tell "found and active" apart from "resigned, FK-safe fallback used".
  assert.match(
    service,
    /if \(!isActiveEmployeeHrId\(input\.assignedHrId, byHrId\) \|\| !storedHrId\)/,
    "pushRow must reject a resolvable-but-resigned approver, not just a wholly unresolvable one",
  );

  // 2. The decision path resolves the actor ONCE and writes the resolved casing into EVERY
  //    employees-FK column it touches (decision_by_hr_id AND updated_by_hr_id on the request row).
  const storedActorDefs =
    service.match(/const storedActorHrId = resolveStoredEmployeeHrId\(actorHrId, employeeRowByHrId\(employeeRows\)\) \?\? actorHrId;/g) ?? [];
  assert.equal(
    storedActorDefs.length,
    2,
    "the decision and finance-evidence flows must each resolve the actor to the employee-master casing",
  );
  // Since the sequential writes were replaced by phx_decide_marketing_request_step, TypeScript no
  // longer writes decision_by_hr_id / updated_by_hr_id directly — it passes storedActorHrId as
  // p_decided_by and the RPC stores it into both columns atomically inside the transaction.
  assert.match(service, /p_decided_by: storedActorHrId/, "the atomic RPC must receive the resolved actor casing via p_decided_by");
  // The advisory comment reuses the CC step's already-resolved (real-cased) assigned_hr_id.
  assert.match(service, /decision_by_hr_id: ccStep\.assignedHrId/, "the advisory comment must store the CC step's real-cased HR_ID");

  // 2b. Finance-evidence uploads write the resolved casing into all three employees-FK columns.
  for (const col of ["finance_reviewer_hr_id", "money_transfer_proof_uploaded_by_hr_id", "invoice_uploaded_by_hr_id"]) {
    assert.match(
      service,
      new RegExp(`${col}: storedActorHrId`),
      `finance evidence must store the resolved casing into ${col}`,
    );
  }

  // 2c. NO employees-FK column is ever written with the raw lower-cased decision/finance actor id.
  assert.doesNotMatch(service, /decision_by_hr_id: actorHrId\b/, "decision_by_hr_id must never store the raw lower-cased actor id");
  assert.doesNotMatch(service, /finance_reviewer_hr_id: actorHrId\b/, "finance_reviewer_hr_id must never store the raw lower-cased actor id");
  assert.doesNotMatch(service, /_uploaded_by_hr_id: actorHrId\b/, "no *_uploaded_by_hr_id may store the raw lower-cased actor id");

  // 3. The inbox reads match every HR_ID dialect, so an approver's inbox is never silently empty.
  assert.match(
    service,
    /const actorHrKeys = hrIdLookupKeys\(actorHrId\)/,
    "the approver inbox must expand the actor id into every HR_ID dialect",
  );
  // Four queries now: the actor's own CURRENT gating step, their CC steps, (2026-08-04) the steps
  // still PENDING for them — the "coming to you" tracking rows — and the sidebar pending-count
  // badge in getMarketingApproverBadge. Every one of them must use the dialect-expanded keys, or
  // that section silently empties for exactly the approvers whose HR_ID casing differs between the
  // session and the employee master. (A badge stuck on zero reads as "nothing waiting on me",
  // which is worse than an empty page — nobody opens the page to discover otherwise.)
  const inboxFilters = service.match(/\.in\("assigned_hr_id", actorHrKeys\)/g) ?? [];
  assert.equal(
    inboxFilters.length,
    4,
    "all four approver-scoped queries (gating + CC + upcoming + nav badge) must match assigned_hr_id case-insensitively",
  );
  // The real invariant behind the count above: no approver-scoped read may filter assigned_hr_id by
  // exact match. A new query added with .eq() would leave the count at 4 and still be broken.
  assert.doesNotMatch(
    service,
    /\.eq\("assigned_hr_id"/,
    "no approver-scoped query may match assigned_hr_id exactly — the session id and employee master disagree on casing",
  );

  // ── The drafts route must NOT mask a real constraint violation as "schema not applied" ──
  const draftsRoute = source("app/api/marketing-requests/drafts/route.ts");
  assert.match(
    draftsRoute,
    /isConstraintViolation/,
    "the drafts error mapper must explicitly detect constraint violations",
  );
  assert.match(
    draftsRoute,
    /!isConstraintViolation\s*&&/,
    "a constraint violation must never be reported as a missing schema",
  );
}
