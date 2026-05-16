/**
 * Resignation Data Integrity Diagnostic & Recovery Script
 * 
 * Purpose: Identify and fix corrupted resignation data where employees
 * marked as "resigned" are re-appearing as "active"
 * 
 * Root cause: Employment status was changed back to "active" without workflow cancellation
 */

import { getSupabaseAdmin } from "@/lib/supabase/server";

type ResignationDataIssue = {
  hrId: string;
  employeeName: string;
  currentEmploymentStatus: string;
  hasResignationWorkflow: boolean;
  resignationWorkflowStatus: string | null;
  issue: string;
};

export async function auditResignationDataIntegrity(): Promise<{
  issues: ResignationDataIssue[];
  summary: {
    totalCorruptedRecords: number;
    restoredCount: number;
    manualReviewRequired: number;
  };
}> {
  const supabase = getSupabaseAdmin();

  // Find all employees with resignation workflows
  const { data: resignations, error: resignationError } = await supabase
    .from("employee_resignations")
    .select("id,employee_hr_id,status,effective_date,completed_at");

  if (resignationError) throw resignationError;

  const resignedHrIds = new Set(
    (resignations ?? [])
      .filter((r: any) => r.status !== "rejected" && r.status !== "cancelled")
      .map((r: any) => r.employee_hr_id?.trim().toUpperCase()),
  );

  // Query: Employees linked to active resignations but with "active" status
  const { data: corruptedEmployees, error: empError } = await supabase
    .from("employees")
    .select("hr_id,full_name,employment_status,organogram_visible,payroll_eligible")
    .in("hr_id", Array.from(resignedHrIds));

  if (empError) throw empError;

  const issues: ResignationDataIssue[] = [];

  for (const emp of corruptedEmployees ?? []) {
    const hrIdUppercase = emp.hr_id?.trim().toUpperCase();
    const linkedResignation = (resignations ?? []).find(
      (r: any) => r.employee_hr_id?.trim().toUpperCase() === hrIdUppercase,
    );

    if (!linkedResignation) continue;

    // Check for data corruption
    if (emp.employment_status === "active" || emp.employment_status === "on_leave") {
      issues.push({
        hrId: emp.hr_id,
        employeeName: emp.full_name,
        currentEmploymentStatus: emp.employment_status,
        hasResignationWorkflow: true,
        resignationWorkflowStatus: linkedResignation.status,
        issue: `CRITICAL: Employee has active resignation (${linkedResignation.status}) but employment_status is ${emp.employment_status}`,
      });
    }

    if (emp.organogram_visible === true) {
      issues.push({
        hrId: emp.hr_id,
        employeeName: emp.full_name,
        currentEmploymentStatus: emp.employment_status,
        hasResignationWorkflow: true,
        resignationWorkflowStatus: linkedResignation.status,
        issue: `DATA INCONSISTENCY: organogram_visible is true despite resignation`,
      });
    }

    if (emp.payroll_eligible === true) {
      issues.push({
        hrId: emp.hr_id,
        employeeName: emp.full_name,
        currentEmploymentStatus: emp.employment_status,
        hasResignationWorkflow: true,
        resignationWorkflowStatus: linkedResignation.status,
        issue: `DATA INCONSISTENCY: payroll_eligible is true despite resignation`,
      });
    }
  }

  return {
    issues,
    summary: {
      totalCorruptedRecords: issues.length,
      restoredCount: 0,
      manualReviewRequired: issues.length,
    },
  };
}

/**
 * FIX: Force-restore resignation status for all corrupted employees
 */
export async function restoreResignationDataIntegrity(): Promise<{
  fixed: number;
  failed: Array<{ hrId: string; error: string }>;
}> {
  const supabase = getSupabaseAdmin();
  const { issues } = await auditResignationDataIntegrity();
  const failed: Array<{ hrId: string; error: string }> = [];
  let fixed = 0;

  for (const issue of issues) {
    try {
      const { error } = await supabase
        .from("employees")
        .update({
          employment_status: "resigned",
          organogram_visible: false,
          payroll_eligible: false,
          updated_at: new Date().toISOString(),
        })
        .eq("hr_id", issue.hrId);

      if (error) {
        failed.push({ hrId: issue.hrId, error: error.message });
      } else {
        fixed++;
        console.log(`[RESTORED] ${issue.hrId} - ${issue.employeeName}`);
      }
    } catch (err) {
      failed.push({
        hrId: issue.hrId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { fixed, failed };
}

// Usage:
// const audit = await auditResignationDataIntegrity();
// console.log("Issues found:", audit.issues);
// if (audit.issues.length > 0) {
//   const result = await restoreResignationDataIntegrity();
//   console.log("Fixed:", result.fixed, "Failed:", result.failed);
// }
