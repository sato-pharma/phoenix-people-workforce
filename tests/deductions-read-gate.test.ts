import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { permissionMatrix } from "../src/lib/auth/permissions.ts";
import type { AccessContext } from "../src/lib/auth/permissions.ts";
import { isDeductionsReadActor } from "../src/lib/deductions/permissions.ts";
import { collectPortalDeductionScope } from "../src/lib/deductions/portal.ts";

/**
 * Guards the deductions READ boundary (owner instruction, 2026-08-06:
 * "everyone can only see his deductions only").
 *
 * THE INCIDENT THIS PINS. `assertDeductionsReadActor` existed, named the right audience
 * (Super Admin / CEO / Finance Manager) — and was called from NOWHERE. Every admin read
 * route gated on `assertPermission(access, "deductions", "read")` alone, and the RBAC
 * matrix granted `deductions: ["read"]` to Regional Manager so their portal page could
 * show a management subtree. The result: a Regional Manager could call
 * /api/admin/deductions/export and download every employee's deduction amounts,
 * company-wide, for any month — 69 employees and 124,138.96 EGP on live production data.
 * The export route made it worse by checking the "read" action rather than "export",
 * so even a read-only grant could take the data out of the system as a file.
 *
 * Two of these are SOURCE-CONTRACT guards (the same technique tests/crm-portal-scope.test.ts
 * uses): the routes need a Request and Supabase to execute, so the load-bearing call is
 * pinned by asserting the route's source text. That is what catches the actual regression
 * here — deleting a one-line gate — which a behavioural test of the service layer cannot see.
 */
export function runDeductionsReadGateTests() {
  const actor = (role: AccessContext["role"]): Pick<AccessContext, "role"> => ({ role });

  // 1. The read audience is exactly four roles, and no field-management role.
  //
  //    HR Operations joined on 2026-09-03 — the owner, in his own words: "yes give HR access to the
  //    deductions screen." The deductions screen has no self-only mode, so admitting her to it is
  //    company-wide read and nothing less; see src/lib/deductions/permissions.ts for the three
  //    reasons that makes it a small step (she already reads every payslip company-wide, it is the
  //    ops 3 duty "ensure no deduction is processed without evidence and approval", and she holds
  //    no export). Assertion 7 below is the one that keeps that last clause honest.
  for (const role of ["Super Admin", "CEO", "Finance Manager", "HR Operations"] as const) {
    assert.ok(isDeductionsReadActor(actor(role)), `${role} must keep company-wide deductions read`);
  }
  for (const role of [
    "Regional Manager",
    "National Sales Manager",
    "District Manager",
    "Medical Rep",
    "HR Advisory",
    "Marketing Manager",
    "Manager",
    "Financial Advisor",
    "Employee",
  ] as const) {
    assert.ok(
      !isDeductionsReadActor(actor(role)),
      `${role} must NOT be able to read another employee's deductions`,
    );
  }

  // 2. The matrix grant that opened the admin endpoints is gone. Regional Manager keeps
  //    their OWN portal deductions via employee_profile, which is asserted separately below.
  assert.equal(
    permissionMatrix["Regional Manager"].deductions,
    undefined,
    "Regional Manager must hold no `deductions` grant — it is what reached the admin endpoints",
  );
  assert.ok(
    permissionMatrix["Regional Manager"].employee_profile?.includes("read"),
    "Regional Manager must keep employee_profile:read, which is what the portal page gates on",
  );

  // 3. Every company-wide read route calls the module gate. These routes return EVERY
  //    employee's amounts, so the RBAC action alone is not sufficient.
  const guardedRoutes = [
    "app/api/admin/deductions/export/route.ts",
    "app/api/admin/deductions/candidates/route.ts",
    "app/api/admin/deductions/summary/company/route.ts",
    "app/api/admin/deductions/summary/employee/route.ts",
    "app/api/admin/deductions/publish/route.ts",
  ];
  for (const route of guardedRoutes) {
    const source = readFileSync(new URL(`../${route}`, import.meta.url), "utf8");
    assert.match(
      source,
      /assertDeductionsReadActor\(access\)/,
      `${route} must call assertDeductionsReadActor — the RBAC action alone let a read-only role read the whole company`,
    );
  }

  // 4. The export endpoint gates on "export", not "read". A role granted read-only must not
  //    be able to remove the entire company's payroll data as a downloadable file.
  {
    const source = readFileSync(
      new URL("../app/api/admin/deductions/export/route.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      source,
      /assertPermission\(access, "deductions", "export"\)/,
      'the export route must require the "export" action',
    );
    assert.doesNotMatch(
      source,
      /assertPermission\(access, "deductions", "read"\)/,
      'the export route must not fall back to the "read" action',
    );
  }

  // 5. Portal scope is SELF-only for every non-system role — no subtree, no line widening.
  //    Previously a Regional/National/District manager read their whole reporting line's
  //    deduction amounts, which are derived from base salary and therefore disclose pay.
  //    As of the C6 cutover the resolver takes only the access context: any non-system scope
  //    collapses to the caller's OWN compact hr-id, so a management scope cannot widen at all.
  for (const [role, scope] of [
    ["Regional Manager", "hierarchy"],
    ["National Sales Manager", "line"],
    ["District Manager", "team"],
    ["Medical Rep", "self"],
  ] as const) {
    const result = collectPortalDeductionScope({
      access: { hrId: "B-10", loginId: "B-10", role, scope, source: "session" } as AccessContext,
    });
    assert.equal(result.all, false, `${role} must not get unrestricted portal deductions`);
    assert.deepEqual(
      [...result.compactHrIds],
      ["b10"],
      `${role} must see ONLY their own deduction row, never a subordinate's`,
    );
  }

  // 6. Super Admin (system scope) still sees everything — the admin module must not break.
  {
    const result = collectPortalDeductionScope({
      access: { hrId: "PHX-1", loginId: "PHX-1", role: "Super Admin", scope: "system", source: "session" } as AccessContext,
    });
    assert.equal(result.all, true, "system scope must retain full visibility");
  }

  // 7. HR Operations READS and does not EXPORT. This is the half of her 2026-09-03 grant that is
  //    easy to lose: isDeductionsReadActor now admits her, and the export route calls that same
  //    gate, so the ONLY thing standing between her and a downloadable file of every employee's
  //    deduction amounts is the absence of `export` from her matrix grant. Adding "export" to
  //    payroll_inputs would look like tidying two read-only grants into one READ_EXPORT constant
  //    and would silently undo it — which is exactly how the incident in the header happened.
  //
  //    The same split is the owner's own, set for her payslip access on 2026-09-01: she reads the
  //    figures on screen and cannot carry the document out of the building.
  assert.deepEqual(
    permissionMatrix["HR Operations"].deductions,
    ["read"],
    "HR Operations must hold deductions READ ONLY — `export` would let her download every employee's amounts",
  );
  assert.equal(
    permissionMatrix["HR Advisory"].deductions,
    undefined,
    "HR Advisory must hold no `deductions` grant — payroll is absent from the HR Business Partner job description",
  );
}
