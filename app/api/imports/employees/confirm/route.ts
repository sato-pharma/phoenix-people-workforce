import { NextResponse } from "next/server";

import { isSalaryBlindRole } from "@/lib/auth/hr-functions";
import { assertPermission, canAccess } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { provisionNewHireAccess } from "@/lib/employees/access-provisioning";
import { openAndAnnounceNewHireMailboxes } from "@/lib/new-hire-mailbox/notify";
import { invalidateEmployeeDirectoryCache } from "@/lib/employees/employee-directory";
import { invalidateExecutiveDashboardCache } from "@/lib/dashboard/invalidation";
import { isMissingColumnError } from "@/lib/employees/missing-column";
import { loadEmployeeImportExistingState } from "@/lib/imports/employee-import-existing-state";
import { createEmployeeImportPlan } from "@/lib/imports/employee-import-plan";
import {
  salaryBlindImportRefusal,
  withoutMoney,
  withoutPayFlags,
} from "@/lib/imports/employee-import-salary-blind";
import { hrIdsForManagerLinks, managerLinksToWrite } from "@/lib/imports/employee-manager-links";
import { parseImportBooleanFlag } from "@/lib/imports/employee-normalizers";
import { saveSocialInsuranceJobTitles } from "@/lib/hiring-pack/social-insurance-job-title";
import { splitInsertOnly } from "@/lib/imports/org-entity-write-guard";
import { upsertByColumnSet } from "@/lib/imports/upsert-by-column-set";
import type {
  EmployeeImportRecord,
  EmployeeImportValidationResult,
  OrganizationEntityToCreate,
  RawEmployeeImportRow,
  VacantPositionImportRecord,
} from "@/lib/imports/employee-import-types";
import { createSystemNotification } from "@/lib/notifications/system";
import { resolveNotificationPersonRecipients } from "@/lib/notifications/role-recipients";
import { logError } from "@/lib/observability/log";
import { closeVacancyOnHire } from "@/lib/employees/vacancy-closer";
import { normalizePayrollPaymentMode } from "@/lib/payroll/policy";
import {
  forgetReferenceDepartments,
  forgetReferenceLines,
} from "@/lib/reference/reference-lists";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { parseEmployeeUploadRows } from "@/lib/imports/employee-upload-parse";
import { spreadsheetTooLargeMessage, validateSpreadsheetFile, xlsxSpreadsheetValidation } from "@/lib/uploads/spreadsheets";
import { generateVacancySeatCode } from "@/lib/workforce/vacancy-code";
import { shouldCloseVacancyForHire } from "@/lib/workforce/seat-lifecycle";
import { clientSafeErrorMessage, errorMessageOf } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type IdMap = Map<string, number>;
type SupabaseClient = ReturnType<typeof getSupabaseAdmin>;

function truncate(value: string | null, maxLength: number) {
  return value ? value.slice(0, maxLength) : null;
}

function compactCodePart(value: string | null) {
  return value?.replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") ?? null;
}

function vacancyCodeFor(record: VacantPositionImportRecord) {
  return generateVacancySeatCode({
    areaCode: compactCodePart(record.codes.areaCode),
    departmentCode: compactCodePart(record.codes.departmentCode),
    lineCode: compactCodePart(record.codes.lineCode),
    managerHrId: record.managerHrId,
    positionCode: compactCodePart(record.codes.positionCode),
    positionTitle: record.positionTitle ?? record.jobTitle,
    teamCode: compactCodePart(record.codes.teamCode),
  });
}

function shouldRejectImport(result: EmployeeImportValidationResult) {
  // Only reject the whole upload for structural problems that make EVERY row
  // unsafe to import (a required column is missing, so nothing is importable).
  // Per-row validation failures (e.g. a bad birth date) and duplicate HR_IDs are
  // already excluded from rowsToInsert/rowsToUpdate by the import plan, so we apply
  // the valid rows and skip the blocked ones instead of failing the entire batch.
  return result.missingRequiredColumns.length > 0;
}

function validationRejection(result: EmployeeImportValidationResult) {
  return {
    error: "employee_import_validation_failed",
    failedRows: result.failedRows,
    missingRequiredColumns: result.missingRequiredColumns,
    duplicateHrIds: result.duplicateHrIds,
    validationErrors: result.validationErrors,
  };
}

function errorMessage(error: unknown) {
  return errorMessageOf(error);
}

function isSupabaseEnvMissing(error: unknown) {
  const message = errorMessage(error);

  return (
    message.includes("NEXT_PUBLIC_SUPABASE_URL is required") ||
    message.includes("SUPABASE_SERVICE_ROLE_KEY is required")
  );
}

function isDatabaseSchemaMissing(error: unknown) {
  const message = errorMessage(error).toLowerCase();

  return (
    message.includes("could not find the table") ||
    message.includes("relation") && message.includes("does not exist")
  );
}

function isCrmUsernameUniqueViolation(error: unknown) {
  const message = errorMessage(error).toLowerCase();

  return (
    message.includes("employees_crm_username_unique_idx") ||
    (message.includes("duplicate key") && message.includes("crm_username"))
  );
}

function confirmFailureResponse(error: unknown) {
  if (isSupabaseEnvMissing(error)) {
    return NextResponse.json(
      {
        error: "supabase_env_missing",
        message:
          "Supabase environment variables are missing. Add NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to .env.local.",
      },
      { status: 409 },
    );
  }

  if (isCrmUsernameUniqueViolation(error)) {
    return NextResponse.json(
      {
        error: "duplicate_crm_username",
        message:
          "CRM username must be unique. Fix or clear duplicate CRM Username values in the employee import file, then run the import preview again.",
      },
      { status: 400 },
    );
  }

  if (isDatabaseSchemaMissing(error)) {
    return NextResponse.json(
      {
        error: "database_schema_not_ready",
        message:
          "Supabase schema is not ready. Run supabase/phoenix-schema.sql in the Supabase SQL editor.",
      },
      { status: 409 },
    );
  }

  return NextResponse.json(
    { error: "employee_import_confirm_failed", message: clientSafeErrorMessage(error, "The employee import could not be confirmed.") },
    { status: 500 },
  );
}

function codesFor(entities: OrganizationEntityToCreate[]) {
  return entities.map((entity) => entity.code);
}

async function existingCodeSet(
  supabase: SupabaseClient,
  table: string,
  codes: string[],
) {
  if (codes.length === 0) {
    return new Set<string>();
  }

  const { data, error } = await supabase
    .from(table)
    .select("code")
    .in("code", codes);

  if (error) {
    throw new Error(error.message);
  }

  return new Set(
    ((data ?? []) as Array<{ code: string }>).map((row) => String(row.code)),
  );
}

async function idsForCodes(
  supabase: SupabaseClient,
  table: string,
  codes: string[],
) {
  if (codes.length === 0) {
    return new Map<string, number>();
  }

  const { data, error } = await supabase
    .from(table)
    .select("id, code")
    .in("code", codes);

  if (error) {
    throw new Error(error.message);
  }

  return new Map(
    ((data ?? []) as Array<{ code: string; id: number }>).map((row) => [
      String(row.code),
      Number(row.id),
    ]),
  );
}

async function upsertDepartments(
  supabase: SupabaseClient,
  entities: OrganizationEntityToCreate[],
) {
  if (entities.length === 0) {
    return { created: 0, ids: new Map<string, number>() };
  }

  const codes = codesFor(entities);
  const existingCodes = await existingCodeSet(supabase, "departments", codes);
  const now = new Date().toISOString();
  const { error } = await supabase.from("departments").upsert(
    entities.map((entity) => ({
      code: entity.code,
      name: truncate(entity.name, 160) ?? entity.code,
      updated_at: now,
    })),
    { onConflict: "code" },
  );

  if (error) {
    throw new Error(error.message);
  }

  // A department this import just created must be visible to the next reader at once, not in up to
  // a minute: this same request goes on to resolve lines and employees against it, and the pages
  // that read the department list are refreshed the moment the import finishes.
  forgetReferenceDepartments("employee import upserted departments");

  return {
    created: entities.filter((entity) => !existingCodes.has(entity.code))
      .length,
    ids: await idsForCodes(supabase, "departments", codes),
  };
}

async function upsertLines(
  supabase: SupabaseClient,
  entities: OrganizationEntityToCreate[],
  departmentIds: IdMap,
) {
  const importable = entities.filter(
    (entity) => entity.parentCode && departmentIds.has(entity.parentCode),
  );

  if (importable.length === 0) {
    return { created: 0, ids: new Map<string, number>() };
  }

  const codes = codesFor(importable);
  const existingCodes = await existingCodeSet(supabase, "lines", codes);
  const now = new Date().toISOString();
  const { error } = await supabase.from("lines").upsert(
    importable.map((entity) => ({
      code: entity.code,
      department_id: departmentIds.get(entity.parentCode ?? ""),
      name: truncate(entity.name, 160) ?? entity.code,
      updated_at: now,
    })),
    { onConflict: "code" },
  );

  if (error) {
    throw new Error(error.message);
  }

  // Same reason as the departments upsert above: this request resolves employees against the line
  // it has just written.
  forgetReferenceLines("employee import upserted lines");

  return {
    created: importable.filter((entity) => !existingCodes.has(entity.code))
      .length,
    ids: await idsForCodes(supabase, "lines", codes),
  };
}

async function upsertAreas(
  supabase: SupabaseClient,
  entities: OrganizationEntityToCreate[],
  lineIds: IdMap,
) {
  // Area unification: areas are the FIXED 42 canonical set — the import NEVER creates areas.
  // Sales-line rows are already map-or-rejected to a canonical area in the validator; any other
  // (non-sales) area code that does not already exist simply resolves to a null area_id downstream.
  // This is a resolve-only pass: employee area_id is set from a fresh idsForCodes(...) after this,
  // so unknown codes never appear (→ null area) and no new `areas` row is written.
  void lineIds;
  const codes = codesFor(entities);
  if (codes.length === 0) {
    return { created: 0, ids: new Map<string, number>() };
  }
  return { created: 0, ids: await idsForCodes(supabase, "areas", codes) };
}

async function upsertTeams(
  supabase: SupabaseClient,
  entities: OrganizationEntityToCreate[],
  areaIds: IdMap,
) {
  if (entities.length === 0) {
    return { created: 0, ids: new Map<string, number>(), preserved: 0 };
  }

  const codes = codesFor(entities);
  const existingIds = await idsForCodes(supabase, "teams", codes);
  const now = new Date().toISOString();

  // Insert-only. An existing team row is never rewritten from the spreadsheet — including a
  // deactivated one, which a lookup by code still finds even though loadTeamState() reports it as
  // absent. Reactivating a team is a deliberate act for the organogram admin, not a side effect of
  // an employee upload. Full reasoning and the production measurement: org-entity-write-guard.ts.
  const { preserved, toInsert } = splitInsertOnly(entities, (code) =>
    existingIds.has(code),
  );

  for (const entity of toInsert) {
    const { error } = await supabase.from("teams").insert({
      area_id: entity.parentCode ? areaIds.get(entity.parentCode) ?? null : null,
      code: entity.code,
      is_active: true,
      name: truncate(entity.name, 160) ?? entity.code,
      updated_at: now,
    });

    if (error) {
      throw new Error(error.message);
    }
  }

  return {
    created: toInsert.length,
    ids: await idsForCodes(supabase, "teams", codes),
    preserved: preserved.length,
  };
}

function positionScopeByCode(records: EmployeeImportRecord[]) {
  const scope = new Map<
    string,
    {
      areaCode: string | null;
      departmentCode: string | null;
      lineCode: string | null;
    }
  >();

  for (const record of records) {
    const positionCode = record.codes.positionCode;

    if (!positionCode || scope.has(positionCode)) {
      continue;
    }

    scope.set(positionCode, {
      areaCode: record.codes.areaCode,
      departmentCode: record.codes.departmentCode,
      lineCode: record.codes.lineCode,
    });
  }

  return scope;
}

async function upsertPositions(
  supabase: SupabaseClient,
  entities: OrganizationEntityToCreate[],
  records: EmployeeImportRecord[],
  ids: {
    areaIds: IdMap;
    departmentIds: IdMap;
    lineIds: IdMap;
  },
) {
  if (entities.length === 0) {
    return { created: 0, ids: new Map<string, number>() };
  }

  const codes = codesFor(entities);
  const existingCodes = await existingCodeSet(supabase, "positions", codes);
  const now = new Date().toISOString();
  const scopes = positionScopeByCode(records);
  const { error } = await supabase.from("positions").upsert(
    entities.map((entity) => {
      const scope = scopes.get(entity.code);

      return {
        area_id: scope?.areaCode ? ids.areaIds.get(scope.areaCode) : null,
        code: entity.code,
        department_id: scope?.departmentCode
          ? ids.departmentIds.get(scope.departmentCode)
          : null,
        line_id: scope?.lineCode ? ids.lineIds.get(scope.lineCode) : null,
        title: truncate(entity.name, 160) ?? entity.code,
        updated_at: now,
      };
    }),
    { onConflict: "code" },
  );

  if (error) {
    throw new Error(error.message);
  }

  return {
    created: entities.filter((entity) => !existingCodes.has(entity.code))
      .length,
    ids: await idsForCodes(supabase, "positions", codes),
  };
}

async function existingEmployeeHrIds(
  supabase: SupabaseClient,
  hrIds: string[],
) {
  if (hrIds.length === 0) {
    return new Set<string>();
  }

  const { data, error } = await supabase
    .from("employees")
    .select("hr_id")
    .in("hr_id", hrIds);

  if (error) {
    throw new Error(error.message);
  }

  return new Set(
    ((data ?? []) as Array<{ hr_id: string }>).map((row) =>
      String(row.hr_id),
    ),
  );
}

function employeeValues(
  record: EmployeeImportRecord,
  ids: {
    areaIds: IdMap;
    departmentIds: IdMap;
    lineIds: IdMap;
    positionIds: IdMap;
    teamIds: IdMap;
  },
  options: { isExisting: boolean },
) {
  // organogram_visible / payroll_eligible are lifecycle-orthogonal flags the org sets
  // deliberately (e.g. the CEO and other executives are intentionally payroll_eligible=false).
  // NEVER force them true on an update — that silently puts payroll-excluded executives back on
  // payroll. Honour an explicit value from the file; otherwise default only for brand-new hires
  // and leave existing employees exactly as they are.
  const organogramVisibleFlag = parseImportBooleanFlag(record.organogramVisible);
  const payrollEligibleFlag = parseImportBooleanFlag(record.payrollEligible);
  const lifecycleFlags: { organogram_visible?: boolean; payroll_eligible?: boolean } = {};

  if (organogramVisibleFlag !== null) {
    lifecycleFlags.organogram_visible = organogramVisibleFlag;
  } else if (!options.isExisting) {
    lifecycleFlags.organogram_visible = true;
  }

  if (payrollEligibleFlag !== null) {
    lifecycleFlags.payroll_eligible = payrollEligibleFlag;
  } else if (!options.isExisting) {
    lifecycleFlags.payroll_eligible = true;
  }

  const values = {
    full_name: truncate(record.fullName, 220) ?? record.hrId ?? "Unknown",
    hr_id: record.hrId as string,
    ...lifecycleFlags,
    updated_at: new Date().toISOString(),
    ...(record.birthDate ? { birth_date: record.birthDate } : {}),
    ...(record.codes.areaCode && ids.areaIds.has(record.codes.areaCode)
      ? { area_id: ids.areaIds.get(record.codes.areaCode) }
      : {}),
    ...(record.codes.departmentCode && ids.departmentIds.has(record.codes.departmentCode)
      ? { department_id: ids.departmentIds.get(record.codes.departmentCode) }
      : {}),
    ...(record.codes.lineCode && ids.lineIds.has(record.codes.lineCode)
      ? { line_id: ids.lineIds.get(record.codes.lineCode) }
      : {}),
    ...(record.codes.positionCode && ids.positionIds.has(record.codes.positionCode)
      ? { position_id: ids.positionIds.get(record.codes.positionCode) }
      : {}),
    ...(record.codes.teamCode && ids.teamIds.has(record.codes.teamCode)
      ? { team_id: ids.teamIds.get(record.codes.teamCode) }
      : {}),
    ...(record.crmId ? { crm_id: truncate(record.crmId, 80) } : {}),
    ...(record.crmUsername ? { crm_username: truncate(record.crmUsername, 160) } : {}),
    ...(record.education ? { education: truncate(record.education, 160) } : {}),
    ...(record.employmentStatus ? { employment_status: record.employmentStatus } : {}),
    ...(record.hireDate ? { hire_date: record.hireDate } : {}),
    ...(record.jobTitle ? { job_title: truncate(record.jobTitle, 160) } : {}),
    ...(record.nickname ? { nickname: truncate(record.nickname, 160) } : {}),
    ...(record.mobileNumber ? { mobile_number: truncate(record.mobileNumber, 40) } : {}),
    ...(record.nameAr ? { name_ar: truncate(record.nameAr, 220) } : {}),
    ...(record.regionName ? { region_name: truncate(record.regionName, 160) } : {}),
    ...(record.regionCode ? { region_code: truncate(record.regionCode, 40) } : {}),
    ...(record.workEmail ? { work_email: truncate(record.workEmail, 255) } : {}),
  };

  return {
    ...values,
    ...(record.hasBankAccount ? { has_bank_account: record.hasBankAccount } : {}),
    ...(record.bankName ? { bank_name: truncate(record.bankName, 120) } : {}),
    ...(record.bankAccount ? { bank_account: truncate(record.bankAccount, 120) } : {}),
    ...(record.compensation.baseSalary !== null ? { base_salary: record.compensation.baseSalary } : {}),
    ...(record.compensation.basicSalary !== null ? { basic_salary: record.compensation.basicSalary } : {}),
    ...(record.compensation.extraCostOfLiving !== null
      ? { extra_cost_of_living: record.compensation.extraCostOfLiving }
      : {}),
    ...(record.compensation.fuelAllowance !== null ? { fuel_allowance: record.compensation.fuelAllowance } : {}),
    ...(record.compensation.grossSalary !== null ? { gross_salary: record.compensation.grossSalary } : {}),
    ...(record.compensation.medicalInsurance !== null
      ? { medical_insurance: record.compensation.medicalInsurance }
      : {}),
    ...(record.compensation.netSalary !== null ? { net_salary: record.compensation.netSalary } : {}),
    ...(record.compensation.paymentMode ? { payment_mode: normalizePayrollPaymentMode(record.compensation.paymentMode) } : {}),
    ...(record.compensation.socialInsurance !== null
      ? { social_insurance: record.compensation.socialInsurance }
      : {}),
    ...(record.compensation.taxes !== null ? { taxes: record.compensation.taxes } : {}),
    ...(record.contractType ? { contract_type: truncate(record.contractType, 80) } : {}),
    ...(record.gender ? { gender: truncate(record.gender, 40) } : {}),
    ...(record.medicalInsuranceStatus ? { medical_insurance_status: record.medicalInsuranceStatus } : {}),
    ...(record.medicalInsuranceNumber
      ? { medical_insurance_number: truncate(record.medicalInsuranceNumber, 120) }
      : {}),
    ...(record.nationalId ? { national_id: truncate(record.nationalId, 120) } : {}),
    ...(record.residenceAddress ? { residence_address: truncate(record.residenceAddress, 500) } : {}),
    ...(record.residenceArea ? { residence_area: truncate(record.residenceArea, 160) } : {}),
    ...(record.residenceCity ? { residence_city: truncate(record.residenceCity, 160) } : {}),
    ...(record.socialInsuranceStatus ? { social_insurance_status: record.socialInsuranceStatus } : {}),
    ...(record.socialInsuranceNumber
      ? { social_insurance_number: truncate(record.socialInsuranceNumber, 120) }
      : {}),
    ...(record.healthCardStatus ? { health_card_status: record.healthCardStatus } : {}),
    ...(record.healthCardNumber ? { health_card_number: truncate(record.healthCardNumber, 120) } : {}),
    ...(record.healthCardReceivedDate ? { health_card_received_date: record.healthCardReceivedDate } : {}),
    // The HR record fields added 2026-09-29. Same shape as everything above: a blank cell is
    // omitted from the payload rather than written, so clearing one in the sheet leaves the stored
    // value alone — which is what the sheet's own row check warns about for the salary block.
    ...(record.birthPlace ? { birth_place: truncate(record.birthPlace, 160) } : {}),
    ...(record.qualification ? { qualification: truncate(record.qualification, 160) } : {}),
    ...(record.universityName ? { university_name: truncate(record.universityName, 160) } : {}),
    ...(record.collegeMajor ? { college_major: truncate(record.collegeMajor, 160) } : {}),
    ...(record.seniorYear ? { senior_year: truncate(record.seniorYear, 40) } : {}),
    // A NUMBER, so tested by type rather than for truth: 0 years is a value HR typed (a new starter
    // with no experience), not a blank cell. Blank, or a column the sheet does not carry, is null.
    ...(typeof record.totalExperienceYears === "number"
      ? { total_experience_years: record.totalExperienceYears }
      : {}),
    ...(record.contractDuration ? { contract_duration: truncate(record.contractDuration, 80) } : {}),
    ...(record.contractRenewalDate ? { contract_renewal_date: record.contractRenewalDate } : {}),
    ...(record.probationEndDate ? { probation_end_date: record.probationEndDate } : {}),
    ...(record.medicalInsuranceCardReceivedDate
      ? { medical_insurance_card_received_date: record.medicalInsuranceCardReceivedDate }
      : {}),
    ...(record.socialInsuranceStartDate
      ? { social_insurance_start_date: record.socialInsuranceStartDate }
      : {}),
    ...(record.kaabElamaalNumber ? { kaab_elamaal_number: truncate(record.kaabElamaalNumber, 120) } : {}),
    ...(record.kaabElamaalIssuer ? { kaab_elamaal_issuer: truncate(record.kaabElamaalIssuer, 160) } : {}),
    ...(record.kaabElamaalIssueDate ? { kaab_elamaal_issue_date: record.kaabElamaalIssueDate } : {}),
    ...(record.kaabElamaalRefund ? { kaab_elamaal_refund: record.kaabElamaalRefund } : {}),
  };
}

function departmentCodesForRecords(records: EmployeeImportRecord[]) {
  return Array.from(
    new Set(
      records.flatMap((record) =>
        record.codes.departmentCode ? [record.codes.departmentCode] : [],
      ),
    ),
  );
}

function recordCodesFor(
  records: EmployeeImportRecord[],
  key: keyof EmployeeImportRecord["codes"],
) {
  return Array.from(
    new Set(
      records.flatMap((record) => {
        const code = record.codes[key];
        return code ? [code] : [];
      }),
    ),
  );
}

function hasResidence(record: EmployeeImportRecord) {
  return Boolean(record.residenceAddress || record.residenceCity || record.residenceArea);
}

function residenceValues(record: EmployeeImportRecord) {
  return {
    employee_hr_id: record.hrId as string,
    geocode_status: record.residenceAddress ? "pending_import_review" : "missing_address",
    residence_address: truncate(record.residenceAddress, 500),
    residence_area: truncate(record.residenceArea, 160),
    residence_city: truncate(record.residenceCity, 160),
    updated_at: new Date().toISOString(),
  };
}

/**
 * The columns `withoutOptionalEmployeeColumns` strips, and the ONLY ones whose absence may send the
 * import down that path. Keep this in the same order as the destructuring below — they are one list
 * in two places, and `tests/optional-employee-columns.test.ts` fails if they ever drift apart.
 */
const OPTIONAL_EMPLOYEE_COLUMNS = [
  "bank_account",
  "bank_name",
  "base_salary",
  "basic_salary",
  "birth_date",
  "contract_type",
  "employment_status",
  "extra_cost_of_living",
  "fuel_allowance",
  "gender",
  "gross_salary",
  "medical_insurance",
  "medical_insurance_number",
  "national_id",
  "net_salary",
  "nickname",
  "organogram_visible",
  "payment_mode",
  "payroll_eligible",
  "region_name",
  "region_code",
  "residence_address",
  "residence_area",
  "residence_city",
  "social_insurance",
  "social_insurance_number",
  "health_card_status",
  "health_card_number",
  "health_card_received_date",
  "birth_place",
  "qualification",
  "university_name",
  "college_major",
  "senior_year",
  "total_experience_years",
  "contract_duration",
  "contract_renewal_date",
  "probation_end_date",
  "medical_insurance_card_received_date",
  "social_insurance_start_date",
  "kaab_elamaal_number",
  "kaab_elamaal_issuer",
  "kaab_elamaal_issue_date",
  "kaab_elamaal_refund",
  "taxes",
  "team_id",
] as const;

/**
 * 🔴 SAYING YES HERE RE-IMPORTS EVERY EMPLOYEE WITH ALL 46 OF THOSE COLUMNS STRIPPED — salary,
 * national id, bank account, contract, residence, insurance — and the import then reports success.
 *
 * It used to say yes to `message.includes(<column>)` for each of them, which is true of any error
 * that merely NAMES one, and to `message.includes("schema cache")`, true of a schema-cache message
 * about any column of any table. So a check-constraint breach, an invalid enum, a NOT NULL
 * violation, a permission denial — or the single word "taxes" anywhere in an unrelated message —
 * silently imported everyone with 45 fields dropped.
 *
 * Now each column is asked properly: 42703 or PGRST204, naming that column, as a whole identifier.
 * That last part matters here more than anywhere — `medical_insurance` was matching
 * `medical_insurance_number`, and `social_insurance` was matching `social_insurance_start_date`.
 */
function isMissingOptionalEmployeeColumn(error: unknown) {
  return OPTIONAL_EMPLOYEE_COLUMNS.some((column) => isMissingColumnError(error, column));
}

function withoutOptionalEmployeeColumns(values: ReturnType<typeof employeeValues>) {
  const {
    bank_account,
    bank_name,
    base_salary,
    basic_salary,
    birth_date,
    contract_type,
    employment_status,
    extra_cost_of_living,
    fuel_allowance,
    gender,
    gross_salary,
    medical_insurance,
    medical_insurance_number,
    national_id,
    net_salary,
    nickname,
    organogram_visible,
    payment_mode,
    payroll_eligible,
    region_name,
    region_code,
    residence_address,
    residence_area,
    residence_city,
    social_insurance,
    social_insurance_number,
    health_card_status,
    health_card_number,
    health_card_received_date,
    birth_place,
    qualification,
    university_name,
    college_major,
    senior_year,
    total_experience_years,
    contract_duration,
    contract_renewal_date,
    probation_end_date,
    medical_insurance_card_received_date,
    social_insurance_start_date,
    kaab_elamaal_number,
    kaab_elamaal_issuer,
    kaab_elamaal_issue_date,
    kaab_elamaal_refund,
    taxes,
    team_id,
    ...rest
  } = values;

  void bank_account;
  void bank_name;
  void base_salary;
  void basic_salary;
  void birth_date;
  void contract_type;
  void employment_status;
  void extra_cost_of_living;
  void fuel_allowance;
  void gender;
  void gross_salary;
  void medical_insurance;
  void medical_insurance_number;
  void national_id;
  void net_salary;
  void nickname;
  void organogram_visible;
  void payment_mode;
  void payroll_eligible;
  void region_name;
  void region_code;
  void residence_address;
  void residence_area;
  void residence_city;
  void social_insurance;
  void social_insurance_number;
  void health_card_status;
  void health_card_number;
  void health_card_received_date;
  void birth_place;
  void qualification;
  void university_name;
  void college_major;
  void senior_year;
  void total_experience_years;
  void contract_duration;
  void contract_renewal_date;
  void probation_end_date;
  void medical_insurance_card_received_date;
  void social_insurance_start_date;
  void kaab_elamaal_number;
  void kaab_elamaal_issuer;
  void kaab_elamaal_issue_date;
  void kaab_elamaal_refund;
  void taxes;
  void team_id;

  return rest;
}

/**
 * The insurance job titles the sheet carried, written to the hiring profile.
 *
 * SEPARATE FROM THE EMPLOYEE UPSERT because the value is not on `employees`: it is
 * `employee_hiring_profile.job_title_ar`, the same Arabic title the contract and Form 1 print
 * (the owner confirmed they are one value on 2026-09-29).
 *
 * A BLANK CELL WRITES NOTHING, exactly like every other column on this sheet. That matters more
 * here than elsewhere: an HR user who downloads the master, edits two salaries and uploads it
 * again must not blank the Arabic title on everybody's contract because their copy of the sheet
 * predates the column.
 *
 * It must not fail the import either. The employees are already written by the time this runs, and
 * a satellite table being unavailable is not a reason to report a successful upload as failed — so
 * the failure is logged and counted as zero.
 */
async function writeSocialInsuranceJobTitles(
  records: EmployeeImportRecord[],
  actorHrId: string | null,
) {
  const entries = records
    .filter((record) => record.hrId && record.socialInsuranceJobTitle)
    .map((record) => ({ hrId: record.hrId as string, jobTitleAr: record.socialInsuranceJobTitle }));
  if (entries.length === 0) return { updated: 0 };

  try {
    return { updated: await saveSocialInsuranceJobTitles(entries, actorHrId) };
  } catch (error) {
    logError("Employee import could not write the social insurance job titles", {
      labels: { event: "employee_import_insurance_job_title_failed" },
      error,
    });
    return { updated: 0 };
  }
}

async function upsertEmployees(
  supabase: SupabaseClient,
  records: EmployeeImportRecord[],
  ids: {
    areaIds: IdMap;
    departmentIds: IdMap;
    lineIds: IdMap;
    positionIds: IdMap;
    teamIds: IdMap;
  },
) {
  const employeeRecords = records.filter((record) => record.hrId);
  const hrIds = employeeRecords.map((record) => record.hrId as string);
  const existingHrIds = await existingEmployeeHrIds(supabase, hrIds);

  if (employeeRecords.length > 0) {
    const values = employeeRecords.map((record) =>
      employeeValues(record, ids, {
        isExisting: existingHrIds.has(record.hrId as string),
      }),
    );
    // One request per column set. A single bulk request lists every column any row carries and
    // writes NULL wherever a row left that cell blank — see upsert-by-column-set.ts.
    let { error } = await upsertByColumnSet(values, (group) =>
      supabase.from("employees").upsert(group, { onConflict: "hr_id" }),
    );

    if (error && isMissingOptionalEmployeeColumn(error)) {
      ({ error } = await upsertByColumnSet(values.map(withoutOptionalEmployeeColumns), (group) =>
        supabase.from("employees").upsert(group, { onConflict: "hr_id" }),
      ));
    }

    if (error) {
      throw new Error(error.message);
    }
  }

  // The lookup includes the managers the rows name: a manager who is not a row in this upload
  // still exists, and checking only the file's own HR_IDs dropped every such link without a word.
  const availableEmployees = await existingEmployeeHrIds(supabase, hrIdsForManagerLinks(employeeRecords));

  for (const link of managerLinksToWrite(employeeRecords, availableEmployees)) {
    const { error } = await supabase
      .from("employees")
      .update({
        manager_hr_id: link.managerHrId,
        updated_at: new Date().toISOString(),
      })
      .eq("hr_id", link.hrId);

    if (error) {
      throw new Error(error.message);
    }
  }

  return {
    imported: employeeRecords.filter(
      (record) => record.hrId && !existingHrIds.has(record.hrId),
    ).length,
    updated: employeeRecords.filter(
      (record) => record.hrId && existingHrIds.has(record.hrId),
    ).length,
  };
}

function hasCompensation(record: EmployeeImportRecord) {
  return Object.values(record.compensation).some((value) => value !== null);
}

function compensationValues(record: EmployeeImportRecord) {
  return {
    employee_hr_id: record.hrId as string,
    updated_at: new Date().toISOString(),
    ...(record.compensation.extraCostOfLiving !== null
      ? { extra_cost_of_living: record.compensation.extraCostOfLiving }
      : {}),
    ...(record.compensation.fuelAllowance !== null ? { fuel_allowance: record.compensation.fuelAllowance } : {}),
    ...(record.compensation.grossSalary !== null ? { gross_salary: record.compensation.grossSalary } : {}),
    ...(record.compensation.medicalInsurance !== null
      ? { medical_insurance: record.compensation.medicalInsurance }
      : {}),
    ...(record.compensation.netSalary !== null ? { net_salary: record.compensation.netSalary } : {}),
    ...(record.compensation.paymentMode ? { payment_mode: normalizePayrollPaymentMode(record.compensation.paymentMode) } : {}),
    ...(record.compensation.socialInsurance !== null
      ? { social_insurance: record.compensation.socialInsurance }
      : {}),
    ...(record.compensation.taxes !== null ? { taxes: record.compensation.taxes } : {}),
  };
}

/**
 * 🔴 THIS DECIDES WHETHER AN IMPORT DROPS EVERYONE'S PAYMENT MODE. When it says yes, the whole
 * compensation upsert is retried with the column stripped out and the import reports success — so a
 * constraint breach or an invalid payment mode, which merely NAME the column, used to be "fixed" by
 * writing every imported employee's salary row without their payment mode at all.
 */
function isMissingPaymentModeColumn(error: unknown) {
  return isMissingColumnError(error, "payment_mode");
}

function withoutPaymentModeColumn(values: ReturnType<typeof compensationValues>) {
  const { payment_mode, ...rest } = values;

  void payment_mode;

  return rest;
}

async function upsertEmployeeCompensation(
  supabase: SupabaseClient,
  records: EmployeeImportRecord[],
) {
  const compensationRecords = records.filter(
    (record) => record.hrId && hasCompensation(record),
  );

  if (compensationRecords.length === 0) {
    return { upserted: 0 };
  }

  const values = compensationRecords.map(compensationValues);
  // One request per column set, as in upsertEmployees: a blank salary cell keeps the saved figure.
  let { error } = await upsertByColumnSet(values, (group) =>
    supabase.from("employee_compensation").upsert(group, { onConflict: "employee_hr_id" }),
  );

  if (error && isMissingPaymentModeColumn(error)) {
    ({ error } = await upsertByColumnSet(values.map(withoutPaymentModeColumn), (group) =>
      supabase.from("employee_compensation").upsert(group, { onConflict: "employee_hr_id" }),
    ));
  }

  if (error) {
    throw new Error(error.message);
  }

  return { upserted: compensationRecords.length };
}

async function upsertEmployeeResidenceLocations(
  supabase: SupabaseClient,
  records: EmployeeImportRecord[],
) {
  const residenceRecords = records.filter(
    (record) => record.hrId && hasResidence(record),
  );

  if (residenceRecords.length === 0) {
    return { upserted: 0 };
  }

  const { error } = await supabase.from("employee_locations").upsert(
    residenceRecords.map(residenceValues),
    { onConflict: "employee_hr_id" },
  );

  if (error) {
    if (isDatabaseSchemaMissing(error)) {
      return { upserted: 0 };
    }

    throw new Error(error.message);
  }

  return { upserted: residenceRecords.length };
}

async function closeVacanciesForImportedEmployees(
  records: EmployeeImportRecord[],
  ids: {
    areaIds: IdMap;
    departmentIds: IdMap;
    lineIds: IdMap;
    positionIds: IdMap;
  },
) {
  let closed = 0;

  for (const record of records) {
    const areaId = record.codes.areaCode ? ids.areaIds.get(record.codes.areaCode) ?? null : null;
    const departmentId = record.codes.departmentCode
      ? ids.departmentIds.get(record.codes.departmentCode) ?? null
      : null;
    const lineId = record.codes.lineCode ? ids.lineIds.get(record.codes.lineCode) ?? null : null;
    const positionId = record.codes.positionCode ? ids.positionIds.get(record.codes.positionCode) ?? null : null;

    if (
      !record.hrId ||
      !shouldCloseVacancyForHire({
        areaId,
        employmentStatus: record.employmentStatus,
        lineId,
        managerHrId: record.managerHrId,
        positionId,
      })
    ) {
      continue;
    }

    const closedVacancy = await closeVacancyOnHire({
      area_id: areaId,
      department_id: departmentId,
      filled_by_hr_id: record.hrId,
      line_id: lineId,
      manager_hr_id: record.managerHrId,
      position_id: positionId,
    });

    if (closedVacancy) {
      closed += 1;
    }
  }

  return { closed };
}

async function existingVacancyCodes(
  supabase: SupabaseClient,
  vacancyCodes: string[],
) {
  if (vacancyCodes.length === 0) {
    return new Set<string>();
  }

  const { data, error } = await supabase
    .from("position_vacancies")
    .select("vacancy_code")
    .in("vacancy_code", vacancyCodes);

  if (error) {
    throw new Error(error.message);
  }

  return new Set(
    ((data ?? []) as Array<{ vacancy_code: string }>).map((row) =>
      String(row.vacancy_code),
    ),
  );
}

function vacancyValues(
  record: VacantPositionImportRecord,
  ids: {
    areaIds: IdMap;
    departmentIds: IdMap;
    lineIds: IdMap;
    positionIds: IdMap;
  },
) {
  return {
    area_id: record.codes.areaCode
      ? ids.areaIds.get(record.codes.areaCode) ?? null
      : null,
    department_id: record.codes.departmentCode
      ? ids.departmentIds.get(record.codes.departmentCode) ?? null
      : null,
    job_title: truncate(record.jobTitle ?? record.positionTitle, 160),
    line_id: record.codes.lineCode
      ? ids.lineIds.get(record.codes.lineCode) ?? null
      : null,
    manager_hr_id: truncate(record.managerHrId, 80),
    manager_name: truncate(record.managerName, 220),
    note: "Imported from employee master data row without HR_ID.",
    position_id: record.codes.positionCode
      ? ids.positionIds.get(record.codes.positionCode) ?? null
      : null,
    region_name: truncate(record.regionName, 160),
    source_row_number: record.rowNumber,
    status: "open",
    updated_at: new Date().toISOString(),
    vacancy_code: vacancyCodeFor(record),
  };
}

async function upsertVacancies(
  supabase: SupabaseClient,
  records: VacantPositionImportRecord[],
  ids: {
    areaIds: IdMap;
    departmentIds: IdMap;
    lineIds: IdMap;
    positionIds: IdMap;
  },
) {
  if (records.length === 0) {
    return { created: 0, recorded: 0, updated: 0 };
  }

  const uniqueRecords = Array.from(
    new Map(records.map((record) => [vacancyCodeFor(record), record])).values(),
  );
  const vacancyCodes = uniqueRecords.map(vacancyCodeFor);
  const existingCodes = await existingVacancyCodes(supabase, vacancyCodes);
  const { error } = await supabase.from("position_vacancies").upsert(
    uniqueRecords.map((record) => vacancyValues(record, ids)),
    { onConflict: "vacancy_code" },
  );

  if (error) {
    throw new Error(error.message);
  }

  return {
    created: uniqueRecords.filter((record) => !existingCodes.has(vacancyCodeFor(record)))
      .length,
    recorded: records.length,
    updated: uniqueRecords.filter((record) => existingCodes.has(vacancyCodeFor(record)))
      .length,
  };
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    // Deliberately the `employees` resource, not `imports` — this mutates employee
    // records and Super Admin/Talent Acquisition are the only roles that can reach
    // this page at all. `imports` gates the unrelated /api/admin/users/bulk instead.
    await assertPermission(access, "employees", "import");

    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "missing_file" }, { status: 400 });
    }
    const fileValidation = validateSpreadsheetFile(file, {
      ...xlsxSpreadsheetValidation,
      emptyError: "invalid_excel_file",
      emptyMessage: "Employee import file is empty.",
      tooLargeError: "employee_import_file_too_large",
      tooLargeMessage: spreadsheetTooLargeMessage("Employee import file"),
      unsupportedError: "unsupported_format",
      unsupportedMessage: "Upload an employee import Excel file in .xlsx format.",
    });
    if (!fileValidation.ok) {
      return NextResponse.json({ error: fileValidation.error, message: fileValidation.message }, { status: fileValidation.status });
    }

    const parsed = await parseEmployeeUploadRows<RawEmployeeImportRow>(file);

    if ("error" in parsed) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    // The same two server-side decisions the dry run makes (dry-run/route.ts): the salary-blind
    // seat's file carries no figure or it is refused whole, and an importer without
    // `employees:create` updates the master without adding anyone to it.
    const salaryBlind = isSalaryBlindRole(access.role);
    if (salaryBlind) {
      const refusal = salaryBlindImportRefusal(parsed.rows);
      if (refusal) return NextResponse.json(refusal, { status: 400 });
    }
    const allowNewEmployees = await canAccess(access, "employees", "create");

    const supabase = getSupabaseAdmin();
    const existingState = await loadEmployeeImportExistingState(supabase);
    const dryRunResult = createEmployeeImportPlan(parsed.rows, {
      allowNewEmployees,
      existingState,
      firstDataRowNumber: parsed.firstDataRowNumber,
      salaryBlind,
    });

    if (salaryBlind) {
      // Belt and braces at the write: the plan already carries no figure for this seat, and every
      // writer below (employeeValues, compensationValues) writes a money column only when its
      // value is non-null — so blanking here again means no salary, allowance, insurance or tax
      // column can reach the database from her upload, whatever the plan does in future. The same
      // for PAYMENT MODE and PAYROLL ELIGIBLE (owner, 2026-10-20: "can change bank account but
      // never a paymode"): employeeValues writes payroll_eligible only for a recognised word and
      // payment_mode only for a non-null mode, so nulling both here means her upload never
      // writes either — a differing cell has already blocked its row in the validator.
      for (const record of [...dryRunResult.rowsToInsert, ...dryRunResult.rowsToUpdate]) {
        withoutMoney(record);
        withoutPayFlags(record);
      }
    }

    if (shouldRejectImport(dryRunResult)) {
      return NextResponse.json(validationRejection(dryRunResult), {
        status: 400,
      });
    }

    const importRecords = [
      ...dryRunResult.rowsToInsert,
      ...dryRunResult.rowsToUpdate,
      ...dryRunResult.vacantPositionsToCreate,
    ];
    const departmentResult = await upsertDepartments(
      supabase,
      dryRunResult.organizationEntitiesToCreate.departments,
    );
    const departmentIds = await idsForCodes(
      supabase,
      "departments",
      departmentCodesForRecords(importRecords),
    );
    const lineResult = await upsertLines(
      supabase,
      dryRunResult.organizationEntitiesToCreate.lines,
      departmentIds,
    );
    const lineIds = await idsForCodes(
      supabase,
      "lines",
      recordCodesFor(importRecords, "lineCode"),
    );
    const areaResult = await upsertAreas(
      supabase,
      dryRunResult.organizationEntitiesToCreate.areas,
      lineIds,
    );
    const areaIds = await idsForCodes(
      supabase,
      "areas",
      recordCodesFor(importRecords, "areaCode"),
    );
    const teamResult = await upsertTeams(
      supabase,
      dryRunResult.organizationEntitiesToCreate.teams,
      areaIds,
    );
    const teamIds = await idsForCodes(
      supabase,
      "teams",
      recordCodesFor(importRecords, "teamCode"),
    );
    const positionResult = await upsertPositions(
      supabase,
      dryRunResult.organizationEntitiesToCreate.positions,
      importRecords,
      {
        areaIds,
        departmentIds,
        lineIds,
      },
    );
    const positionIds = await idsForCodes(
      supabase,
      "positions",
      recordCodesFor(importRecords, "positionCode"),
    );
    const employeeResult = await upsertEmployees(
      supabase,
      [...dryRunResult.rowsToInsert, ...dryRunResult.rowsToUpdate],
      {
        areaIds,
        departmentIds,
        lineIds,
        positionIds,
        teamIds,
      },
    );
    const compensationResult = await upsertEmployeeCompensation(
      supabase,
      [...dryRunResult.rowsToInsert, ...dryRunResult.rowsToUpdate],
    );
    const insuranceJobTitleResult = await writeSocialInsuranceJobTitles(
      [...dryRunResult.rowsToInsert, ...dryRunResult.rowsToUpdate],
      access.hrId ?? null,
    );
    const residenceResult = await upsertEmployeeResidenceLocations(
      supabase,
      [...dryRunResult.rowsToInsert, ...dryRunResult.rowsToUpdate],
    );
    const closedVacancyResult = await closeVacanciesForImportedEmployees(
      dryRunResult.rowsToInsert,
      {
        areaIds,
        departmentIds,
        lineIds,
        positionIds,
      },
    );
    const accessProvisioning = await provisionNewHireAccess({
      actor: { loginId: access.loginId ?? null, role: access.role },
      hrIds: dryRunResult.rowsToInsert.map((record) => record.hrId),
      source: "bulk employee import",
    });
    const vacancyResult = await upsertVacancies(
      supabase,
      dryRunResult.vacantPositionsToCreate,
      {
        areaIds,
        departmentIds,
        lineIds,
        positionIds,
      },
    );

    const response = {
      accessUsersCreated: accessProvisioning.created,
      accessUsersFailed: accessProvisioning.failed,
      accessUsersSkipped: accessProvisioning.skipped,
      blockedRows: dryRunResult.failedRows,
      validationErrors: dryRunResult.validationErrors,
      createdAreas: areaResult.created,
      createdDepartments: departmentResult.created,
      createdLines: lineResult.created,
      createdPositions: positionResult.created,
      createdTeams: teamResult.created,
      createdVacancies: vacancyResult.created,
      closedVacancies: closedVacancyResult.closed,
      importedEmployees: employeeResult.imported,
      importedCompensationRows: compensationResult.upserted,
      updatedInsuranceJobTitles: insuranceJobTitleResult.updated,
      importedResidenceRows: residenceResult.upserted,
      // Teams the sheet named that already exist and were left exactly as they are — including any
      // that are deactivated. Reported rather than silent, because "the import quietly left this
      // alone" is the fact somebody needs when a team looks stale after an upload.
      preservedTeams: teamResult.preserved,
      recordedVacancies: vacancyResult.recorded,
      skippedVacantRows: 0,
      updatedEmployees: employeeResult.updated,
      updatedVacancies: vacancyResult.updated,
      userAccessProvisioning: accessProvisioning.results,
      warnings: dryRunResult.validationWarnings,
    };

    // Who hears that an import landed: the admin who ran it, plus Super Admin for oversight
    // (owner decision 2026-08-09).
    //
    // These have to be passed EXPLICITLY. The employee_import.* policy uses
    // recipientStrategy: ["permission_based"], and permission_based resolves an audience by
    // scope-matching candidates against the notification's SUBJECT. An import is an ops event
    // about a FILE, not about a person, so there is no subject — and `if (!subject) continue`
    // (policy.ts) then discards every candidate, including the company-scope Super Admin/CEO
    // bypass that sits a few lines below it. The result was a fail-closed skip on every channel:
    // this notification reached nobody at all, on every import, while recording
    // "no exact authorized recipient was resolved" as though it were a permissions failure.
    //
    // metadata.moduleOwnerHrIds is the supported way to name recipients for a subject-less ops
    // notification; permission_based consumes it directly and still requires each named person
    // to hold `imports:import`, so this names an audience without widening authorization.
    const { recipients: importOversightRecipients, warnings: importAlertWarnings } =
      await resolveNotificationPersonRecipients("employee_import_alert", "Employee import alert recipients");
    if (importAlertWarnings.length > 0) {
      logError("Employee import alert recipient resolution warned", {
        labels: { event: "employee_import_alert_recipients_warning" },
        error: new Error(importAlertWarnings.join("; ")),
      });
    }
    const importAlertHrIds = Array.from(
      new Set(
        [access.hrId, ...importOversightRecipients.map((recipient) => recipient.hrId)]
          .map((hrId) => String(hrId ?? "").trim())
          .filter(Boolean),
      ),
    );

    await createSystemNotification({
      actionUrl: "/employees",
      actorId: access.loginId ?? access.hrId ?? access.role,
      email: {
        ctaHref: "/employees",
        ctaLabel: "Open employee directory",
        metrics: [
          { label: "Imported employees", value: response.importedEmployees },
          { label: "Access users created", value: response.accessUsersCreated },
          { label: "Updated employees", value: response.updatedEmployees },
          { label: "Recorded vacancies", value: response.recordedVacancies },
          { label: "Closed vacancies", value: response.closedVacancies },
          { label: "Warnings", value: response.warnings.length },
        ],
        notificationType: "general",
        subject: `Phoenix employee import completed - ${file.name}`,
        summary: "An employee import was confirmed and written to the workforce directory.",
        title: "Employee Import Completed",
        tone: response.warnings.length > 0 ? "warning" : "success",
      },
      eventType: "employee_import_completed",
      message: "An employee import was confirmed and written to the workforce directory.",
      metadata: {
        accessUsersCreated: response.accessUsersCreated,
        idempotencyKey: `employee-import:${file.name}:${Date.now()}`,
        importedEmployees: response.importedEmployees,
        moduleOwnerHrIds: importAlertHrIds,
        warnings: response.warnings.length,
      },
      module: "employee_import",
      priority: response.warnings.length > 0 ? "high" : "normal",
      title: "Employee Import Completed",
    });

    invalidateEmployeeDirectoryCache();
    // The same modules a single employee save busts (employee-directory.ts upsertEmployee): an import
    // fills vacancies and moves seats, so without this the org tree kept the filled seats open and
    // the finance landing kept the old headcount for up to their 300s TTL (cache audit, 2026-10-26).
    invalidateExecutiveDashboardCache("employee import confirmed", ["employees", "vacancies", "payroll"]);

    // Each employee the sheet CREATED gets a company email (owner instruction 2026-09-18).
    // `rowsToInsert` is the same list access provisioning uses above, so the two can never disagree
    // about who is new. Rows the import only UPDATED are deliberately excluded: those people already
    // existed and were never announced. The cache is cleared first, on purpose: the notice reads each
    // new hire back out of the directory, and a stale read would send a notice full of blanks.
    //
    // The iReports360 account-setup notice that used to go out here is RETIRED (2026-11-07): the
    // vendor CRM was retired on 6 Nov 2026 and Phoenix CRM is the only source of field work.
    if (dryRunResult.rowsToInsert.length > 0) {
      await openAndAnnounceNewHireMailboxes({
        actorId: access.loginId ?? access.hrId ?? access.role,
        hrIds: dryRunResult.rowsToInsert.map((record) => record.hrId),
        source: "employee_import",
      });
    }

    return NextResponse.json(response);
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "You do not have access to import employees." }, { status: 403 });
    }

    return confirmFailureResponse(error);
  }
}
