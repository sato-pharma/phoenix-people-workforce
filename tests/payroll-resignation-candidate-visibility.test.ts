import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const typesSource = readFileSync(
  new URL("../src/lib/payroll/types.ts", import.meta.url),
  "utf8",
);

const payrollServiceSource = readFileSync(
  new URL("../src/lib/payroll/service.ts", import.meta.url),
  "utf8",
);

const governanceSource = readFileSync(
  new URL("../src/components/payroll/dashboard/payroll-workflow-governance.tsx", import.meta.url),
  "utf8",
);

const payrollDashboardSource = readFileSync(
  new URL("../src/components/payroll/payroll-dashboard.tsx", import.meta.url),
  "utf8",
);

const uploadRouteSource = readFileSync(
  new URL("../app/api/payroll/upload/route.ts", import.meta.url),
  "utf8",
);

const replaceRouteSource = readFileSync(
  new URL("../app/api/payroll/[id]/replace/route.ts", import.meta.url),
  "utf8",
);

// This module locks in an ADDITIVE, read-only visibility feature: the payroll batch
// dashboard cross-references each batch's HR IDs against the resignation-candidate
// registry so an approver can see, in-context, which rows were flagged as likely
// resignations during a payroll upload. It must never change the deliberate stripping of
// `employee_not_found` out of the salary_flags governance table (that behavior is locked
// by tests/payroll-engine-hardening.test.ts). The final block below re-asserts that
// stripping so a reviewer can confirm this fix is orthogonal.
export function runPayrollResignationCandidateVisibilityTests() {
  // 1. PayrollDashboardData exposes the new resignation cross-reference fields.
  assert.match(
    typesSource,
    /resignationCandidateCount:\s*number;/,
    "PayrollDashboardData must expose resignationCandidateCount for the batch dashboard banner.",
  );
  assert.match(
    typesSource,
    /resignationCandidates:\s*Array<\{[\s\S]*?fullName:\s*string;[\s\S]*?hrId:\s*string;[\s\S]*?lastPayoutMonth:\s*number;[\s\S]*?lastPayoutYear:\s*number;[\s\S]*?\}>;/,
    "PayrollDashboardData.resignationCandidates must carry hrId/fullName/lastPayoutMonth/lastPayoutYear.",
  );

  // 2. emptyPayrollDashboard defaults the new fields (covers every early-return path,
  //    which all spread ...emptyPayrollDashboard).
  assert.match(
    payrollServiceSource,
    /resignationCandidateCount:\s*0,/,
    "emptyPayrollDashboard must default resignationCandidateCount to 0.",
  );
  assert.match(
    payrollServiceSource,
    /resignationCandidates:\s*\[\],/,
    "emptyPayrollDashboard must default resignationCandidates to an empty array.",
  );

  // 3. getPayrollDashboard cross-references the batch's HR IDs against the registry via the
  //    admin (service-role) client, because payroll_resignation_candidates is RLS-locked to
  //    service_role. Using the RLS-scoped client would silently return nothing.
  assert.match(
    payrollServiceSource,
    /getSupabaseAdmin\(\)\s*\.from\("payroll_resignation_candidates"\)/,
    "getPayrollDashboard must read payroll_resignation_candidates via getSupabaseAdmin() (service-role RLS).",
  );
  assert.match(
    payrollServiceSource,
    /\.select\("hr_id, employee_name, last_payout_month, last_payout_year"\)/,
    "getPayrollDashboard must select the resignation-candidate registry columns.",
  );
  assert.match(
    payrollServiceSource,
    /\.in\("hr_id",\s*batchHrIds\)/,
    "getPayrollDashboard must scope the registry lookup to the batch's HR IDs.",
  );
  assert.match(
    payrollServiceSource,
    /resignationCandidateCount:\s*resignationCandidates\.length/,
    "getPayrollDashboard must return resignationCandidateCount derived from the resolved candidates.",
  );

  // 4. The cross-reference must be read-only against the registry (the write path lives in
  //    the resignations service, not the payroll dashboard read path).
  assert.doesNotMatch(
    payrollServiceSource,
    /from\("payroll_resignation_candidates"\)[\s\S]{0,120}?\.(insert|upsert|update|delete)\(/,
    "The payroll dashboard cross-reference must not mutate the resignation-candidate registry.",
  );

  // 5. The new banner component exists, renders nothing when empty, previews the first
  //    candidates, and links to the Resignations report.
  assert.match(
    governanceSource,
    /export function PayrollResignationCandidatesBanner/,
    "payroll-workflow-governance must export PayrollResignationCandidatesBanner.",
  );
  assert.match(
    governanceSource,
    /if \(candidates\.length === 0\) return null/,
    "PayrollResignationCandidatesBanner must render nothing when there are no candidates.",
  );
  assert.match(
    governanceSource,
    /candidates\.slice\(0,\s*8\)/,
    "PayrollResignationCandidatesBanner must preview the first candidates with a '+N more' overflow.",
  );
  assert.match(
    governanceSource,
    /href="\/resignations"/,
    "PayrollResignationCandidatesBanner must link to the Resignations report route.",
  );

  // 6. The dashboard renders the banner wired to the new dashboard-data fields.
  assert.match(
    payrollDashboardSource,
    /PayrollResignationCandidatesBanner/,
    "PayrollDashboard must render PayrollResignationCandidatesBanner.",
  );
  assert.match(
    payrollDashboardSource,
    /data\?\.resignationCandidates/,
    "PayrollDashboard must feed the banner from data.resignationCandidates.",
  );
  assert.match(
    payrollDashboardSource,
    /data\?\.resignationCandidateCount/,
    "PayrollDashboard must feed the banner count from data.resignationCandidateCount.",
  );

  // 7. CRITICAL orthogonality guard: this additive read-side fix must NOT change the locked
  //    stripping of `employee_not_found` out of governance flags. These mirror the locked
  //    assertions in tests/payroll-engine-hardening.test.ts so a reviewer can confirm the
  //    fix leaves salary_flags semantics untouched.
  assert.match(
    uploadRouteSource,
    /warning\)\s*=>\s*warning\.code !== "employee_not_found"/,
    "Payroll upload route must still strip missing-directory HR IDs from governance warning flags.",
  );
  assert.match(
    uploadRouteSource,
    /upsertPayrollResignationCandidates/,
    "Payroll upload route must still route missing-employee rows to the resignation candidate table.",
  );
  assert.match(
    replaceRouteSource,
    /warning\)\s*=>\s*warning\.code !== "employee_not_found"/,
    "Payroll replace route must still strip missing-directory HR IDs from governance warning flags.",
  );
}
