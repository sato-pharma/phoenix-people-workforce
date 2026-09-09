import { NextResponse } from "next/server";

import {
  assertPermission,
  canReadEmployeeDirectory,
  filterEmployeeDirectoryForAccess,
  isSalaryRedactedForViewer,
} from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { provisionNewHireAccess } from "@/lib/employees/access-provisioning";
import { attachEmployeeCvOnCreate } from "@/lib/employees/employee-cv";
import { openAndAnnounceCrmAccountSetup } from "@/lib/crm/account-setup-notify";
import { hrIdsMatch } from "@/lib/hr-id";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import {
  employeeDirectoryErrorMessage,
  getEmployeeDirectory,
  isEmployeeDirectoryEnvMissing,
  isEmployeeDirectorySchemaMissing,
  isEmployeeDirectoryTimeout,
  upsertEmployee,
  type EmployeeMutationInput,
} from "@/lib/employees/employee-directory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function employeeApiError(error: unknown) {
  const message = employeeDirectoryErrorMessage(error);

  if (isForbiddenError(error)) {
    return {
      message,
      status: 403,
    };
  }

  if (isEmployeeDirectoryTimeout(error)) {
    return {
      message: "Supabase request timed out. Check your connection and try again.",
      status: 504,
    };
  }

  if (isEmployeeDirectoryEnvMissing(error)) {
    return {
      message: "Supabase environment variables are missing.",
      status: 409,
    };
  }

  if (isEmployeeDirectorySchemaMissing(error)) {
    return {
      message: "Supabase schema is not ready.",
      status: 409,
    };
  }

  if (message.toLowerCase().includes("employees_crm_username_unique_idx")) {
    return {
      message: "CRM username is already assigned to another employee.",
      status: 400,
    };
  }

  if (
    message.includes("required") ||
    message.includes("not allowed") ||
    message.includes("Invalid HR_ID") ||
    message.includes("format is invalid") ||
    message.includes("cannot be the same employee") ||
    message.includes("Use the resignation workflow") ||
    message.includes("already exists") ||
    message.includes("already assigned") ||
    message.includes("immutable")
  ) {
    return {
      message,
      status: 400,
    };
  }

  if (message.includes("was not found")) {
    return {
      message,
      status: 404,
    };
  }

  return {
    message,
    status: 500,
  };
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (!(await canReadEmployeeDirectory(access))) {
      await assertPermission(access, "employees", "read");
    }

    return NextResponse.json(
      filterEmployeeDirectoryForAccess(await getEmployeeDirectory(), access),
    );
  } catch (error) {
    const { message, status } = employeeApiError(error);
    return NextResponse.json({ error: "employee_load_failed", message }, { status });
  }
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "employees", "update");

    const payload = (await request.json()) as {
      employee?: EmployeeMutationInput;
      // The CV, when the Add Employee form carried one. SIBLINGS OF `employee`, not fields inside
      // it, deliberately: `EmployeeMutationInput` is the shape upsertEmployee writes to the
      // `employees` row, and a draft id is a pointer to a file in a bucket, not a column. Keeping
      // them apart means the CV cannot be dragged into an UPDATE payload by an unrelated edit.
      cvDraftFileName?: string;
      cvDraftId?: string;
      // Set when the hire was started from a recruitment application. Used only to find the CV
      // the candidate themselves sent, and only when no file was chosen on the form.
      fromApplicationId?: string;
    };

    if (!payload.employee) {
      return NextResponse.json(
        { error: "missing_employee", message: "Employee payload is required." },
        { status: 400 },
      );
    }

    // A viewer whose read access to this row's salary is redacted (see
    // isSalaryRedactedForViewer) never has the real figures to submit — their
    // edit form necessarily carries blanked-out values. Splice the CURRENT
    // real values back in before the upsert so an unrelated edit (e.g. a
    // phone number fix) can never silently wipe this employee's real salary.
    if (isSalaryRedactedForViewer(access, payload.employee.hrId)) {
      const currentRow = (await getEmployeeDirectory()).employees.find((employee) =>
        hrIdsMatch(employee.hrId, payload.employee?.hrId ?? ""),
      );
      if (currentRow) {
        payload.employee = {
          ...payload.employee,
          baseSalary: currentRow.baseSalary,
          basicSalary: currentRow.basicSalary,
          extraCostOfLiving: currentRow.extraCostOfLiving,
          fuelAllowance: currentRow.fuelAllowance,
          grossSalary: currentRow.grossSalary,
          medicalInsurance: currentRow.medicalInsurance,
          netSalary: currentRow.netSalary,
          salaryDetails: currentRow.salaryDetails ?? null,
          socialInsurance: currentRow.socialInsurance,
          socialInsuranceWage: currentRow.socialInsuranceWage,
          taxes: currentRow.taxes,
        };
      }
    }

    const savedRows = await upsertEmployee(payload.employee);
    // `originalHrId` is only present when an EXISTING employee is being edited (upsertEmployee
    // derives its own isUpdate from exactly this field), so a blank one is the create signal —
    // the same one access provisioning has always keyed on.
    const isNewEmployee = !payload.employee.originalHrId?.trim();
    const newEmployeeHrId = savedRows[0]?.hr_id ?? payload.employee.hrId;
    const accessProvisioning = isNewEmployee
      ? await provisionNewHireAccess({
        actor: { loginId: access.loginId ?? null, role: access.role },
        hrIds: [newEmployeeHrId],
        source: "manual employee add",
      })
      : null;

    // THE CV GOES ON THE RECORD BEFORE THE NOTICE IS COMPOSED, and that ordering is load-bearing.
    // openAndAnnounceCrmAccountSetup reads the employee back to build the notice, so a CV attached
    // after it would produce a notice saying "No CV on file" about somebody whose CV arrived a
    // second later — with no error anywhere, and a download link that answers 404. Owner
    // instruction 2026-09-09: the notice carries a link the SFE Manager can download the CV from,
    // so the notice has to be composed after the file is there.
    //
    // Swallows its own failures for the same reason the notice below does: the employee row is
    // already written, and a rejected PDF must not fail a save that has succeeded.
    const cvAttachment = isNewEmployee
      ? await attachEmployeeCvOnCreate({
        actorHrId: access.hrId ?? null,
        applicationId: payload.fromApplicationId ?? null,
        cvDraftFileName: payload.cvDraftFileName ?? null,
        cvDraftId: payload.cvDraftId ?? null,
        hrId: newEmployeeHrId,
      })
      : null;

    // A new hire in a FIELD role is invisible in the CRM until somebody creates his iReports360
    // account, and nothing used to say so. Open the setup task and tell the SFE Manager (owner
    // instruction 2026-09-07, narrowed to field roles 2026-09-08). It swallows its own failures:
    // the employee is already saved by this point, and a notification that could 500 the save
    // would mean an unreachable recipient stops HR hiring anybody.
    if (isNewEmployee) {
      await openAndAnnounceCrmAccountSetup({
        actorId: access.loginId ?? access.hrId ?? access.role,
        hrIds: [newEmployeeHrId],
        source: "manual_add",
      });
    }

    const directory = await getEmployeeDirectory();

    return NextResponse.json(
      {
        ...filterEmployeeDirectoryForAccess(directory, access),
        ...(accessProvisioning ? { accessProvisioning } : {}),
        // Returned so the form can SAY what happened to the CV. A file that was chosen and did not
        // land has to be visible at the moment of the save — HR closes this dialog and never comes
        // back, and a silently missing CV is discovered weeks later by the person who needed it.
        ...(cvAttachment ? { cvAttachment } : {}),
      },
    );
  } catch (error) {
    const { message, status } = employeeApiError(error);
    return NextResponse.json({ error: "employee_save_failed", message }, { status });
  }
}
