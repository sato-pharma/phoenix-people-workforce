/**
 * The Company Vacation Report's source vocabulary, in a leaf module with NO server imports.
 *
 * Why it is not in company-vacation-report.ts beside everything else: that module reaches
 * `@/lib/crm/reads` -> `@/lib/employees/employee-directory` -> `node:crypto`, and the report table
 * is a `"use client"` component. Importing a TYPE from a server module is free (types are erased),
 * which is why the table has always been able to say `import type { CompanyVacationReportRow }`
 * and get away with it. Importing a VALUE is not: it drags the whole server graph into the client
 * bundle, and the dev build fails outright with
 *   Module build failed: UnhandledSchemeError: Reading from "node:crypto" is not handled
 * naming the table as the importer. So the source list and the Phoenix/CRM mapping the client
 * needs at RUNTIME live here, and company-vacation-report.ts re-exports the type only.
 *
 * THIS MODULE IMPORTS NOTHING, and tests/sfe-vacation-source-report.test.ts holds it to exactly
 * that — zero import statements, not "zero risky ones". The blunt version is deliberate: what it
 * guards against is a hard build error, so the check has to be unambiguous rather than a judgement
 * about which import is safe today. The leave-type vocabulary therefore does NOT live here even
 * though it is the same kind of thing; it sits in company-vacation-report-filters.ts, which is
 * equally client-safe but is already allowed imports.
 */

export type CompanyVacationReportSource =
  | "HR Approved"
  | "HR Pending"
  | "HR Rejected"
  | "HR Cancelled"
  | "CRM Signal — Vacation"
  | "CRM Signal — Half-Day (Attendance Partial)";

/**
 * The same six values as a runtime list, so the exhaustive `Record<CompanyVacationReportSource, …>`
 * lookups built on them (the table's badge classes, the workbook's row fills) can be ASSERTED
 * rather than assumed. `next.config` sets `typescript: { ignoreBuildErrors: true }`, so a Record
 * missing a key compiles, builds and deploys — a missing workbook fill would hand ExcelJS
 * `undefined` as an ARGB. tests/sfe-vacation-source-report.test.ts iterates this list and checks
 * every lookup returns something real.
 */
export const COMPANY_VACATION_REPORT_SOURCES = [
  "HR Approved",
  "HR Pending",
  "HR Rejected",
  "HR Cancelled",
  "CRM Signal — Vacation",
  "CRM Signal — Half-Day (Attendance Partial)",
] as const satisfies readonly CompanyVacationReportSource[];

/**
 * Compile-time proof the list above covers the WHOLE union. `satisfies` only checks that every
 * listed value is a member — it says nothing about a member nobody listed. This says the other
 * half: add a seventh source to the type without adding it here and `Unlisted` stops being
 * `never`, which makes this line a type error in the PR's typecheck job. The runtime half of the
 * same guard lives in the test named above, because the build itself would not catch it.
 */
type UnlistedCompanyVacationReportSource = Exclude<
  CompanyVacationReportSource,
  (typeof COMPANY_VACATION_REPORT_SOURCES)[number]
>;
const everyCompanyVacationReportSourceIsListed: never = undefined as unknown as UnlistedCompanyVacationReportSource;
void everyCompanyVacationReportSourceIsListed;

/**
 * WHICH SYSTEM the day came from, in the words the business uses for it: a request the employee
 * submitted through Phoenix, or a vacation the field CRM recorded on its own.
 *
 * Derived from `source` rather than stored beside it — the six source values already determine
 * this completely, and a second stored field is a second thing that can disagree with the first.
 * The detailed `source` stays exactly as it was (it carries the HR status, which the reader still
 * needs); this is the coarse question the owner actually asks first: where did this come from?
 */
export type CompanyVacationSourceSystem = "Phoenix" | "CRM";

export const COMPANY_VACATION_SOURCE_SYSTEMS = ["Phoenix", "CRM"] as const satisfies readonly CompanyVacationSourceSystem[];

export function companyVacationSourceSystem(source: CompanyVacationReportSource): CompanyVacationSourceSystem {
  return source.startsWith("CRM Signal") ? "CRM" : "Phoenix";
}
