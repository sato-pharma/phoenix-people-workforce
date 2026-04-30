import type {
  EmployeeImportPlanOptions,
  EmployeeImportValidationResult,
  RawEmployeeImportRow,
} from "@/lib/imports/employee-import-types";
import { validateEmployeeImportRows } from "@/lib/imports/employee-validator";

export function createEmployeeImportPlan(
  rows: RawEmployeeImportRow[],
  options: EmployeeImportPlanOptions = {},
): EmployeeImportValidationResult {
  return validateEmployeeImportRows(rows, {
    ...options,
    useOrgRuleEngine: true,
  });
}

export type {
  EmployeeImportPlanOptions,
  EmployeeImportValidationResult,
  RawEmployeeImportRow,
};
