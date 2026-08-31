import {
  provisionEmployeeAccountForRecruiting,
  upsertAccessUser,
  type AccessActor,
} from "@/lib/admin/access-control";
import {
  employeeDirectoryErrorMessage,
  getEmployeeDirectory,
  invalidateEmployeeDirectoryCache,
} from "@/lib/employees/employee-directory";
import { resolveEmployeeAccessRole } from "@/lib/employees/access-role";

export type EmployeeAccessProvisioningResult = {
  hrId: string;
  message?: string;
  status: "created" | "failed" | "skipped";
};

export type EmployeeAccessProvisioningSummary = {
  created: number;
  failed: number;
  results: EmployeeAccessProvisioningResult[];
  skipped: number;
};

function normalizeHrId(value: string | null | undefined) {
  const text = value?.trim();
  return text ? text.toUpperCase() : null;
}

export async function provisionNewHireAccess(input: {
  actor?: AccessActor | null;
  hrIds: Array<string | null | undefined>;
  source: string;
}): Promise<EmployeeAccessProvisioningSummary> {
  const hrIds = Array.from(
    new Set(input.hrIds.map(normalizeHrId).filter((hrId): hrId is string => Boolean(hrId))),
  );

  if (hrIds.length === 0) {
    return {
      created: 0,
      failed: 0,
      results: [],
      skipped: 0,
    };
  }

  invalidateEmployeeDirectoryCache();
  const directory = await getEmployeeDirectory();
  const employeesByHrId = new Map(
    directory.employees.map((employee) => [normalizeHrId(employee.hrId), employee]),
  );
  const results: EmployeeAccessProvisioningResult[] = [];

  for (const hrId of hrIds) {
    const employee = employeesByHrId.get(hrId);
    if (!employee) {
      results.push({
        hrId,
        message: "Employee is not active or not visible in the employee directory.",
        status: "skipped",
      });
      continue;
    }

    try {
      const mutation = {
        email: employee.workEmail,
        governanceReason: `Auto-created from ${input.source} for ${hrId}.`,
        hrId,
        isActive: true,
        line: employee.lineName,
        loginId: hrId,
        managerHrId: employee.managerHrId,
        name: employee.displayName,
        role: resolveEmployeeAccessRole(employee),
      };

      // upsertAccessUser is Super-Admin-only. HR Operations can add employees but could never
      // create their login, so every hire they made ended up unable to sign in. Route them
      // through the create-only, rank-bounded entry point instead of failing.
      // The role named HERE and the guard inside provisionEmployeeAccountForRecruiting must
      // name the SAME seat. They disagreed once — the guard said "HR Advisory" while this line
      // said "HR Operations" — and the guard then rejected the only role that reaches it, so
      // every new joiner was created with no login. tests/hr-provisioning-guard.test.ts pins
      // the pair together; change one and that test fails.
      if (input.actor?.loginId && input.actor.role === "HR Operations") {
        await provisionEmployeeAccountForRecruiting(mutation, input.actor);
      } else {
        await upsertAccessUser(mutation, input.actor);
      }

      results.push({ hrId, status: "created" });
    } catch (error) {
      results.push({
        hrId,
        message: employeeDirectoryErrorMessage(error),
        status: "failed",
      });
    }
  }

  return {
    created: results.filter((result) => result.status === "created").length,
    failed: results.filter((result) => result.status === "failed").length,
    results,
    skipped: results.filter((result) => result.status === "skipped").length,
  };
}
