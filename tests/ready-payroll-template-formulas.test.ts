import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const templateRouteSource = readFileSync(
  new URL("../app/api/payroll/template/route.ts", import.meta.url),
  "utf8",
);
const salaryImportSource = readFileSync(
  new URL("../src/lib/payroll/salary-import.ts", import.meta.url),
  "utf8",
);
// The proration arithmetic moved out of the route so it could be tested by
// behaviour rather than by matching its source text — see
// tests/ready-payroll-proration.test.ts. These source assertions stay only to
// pin the wiring that still lives in the route.
const readyProrationSource = readFileSync(
  new URL("../src/lib/payroll/ready-proration.ts", import.meta.url),
  "utf8",
);

export function runReadyPayrollTemplateFormulaTests() {
  assert.match(
    templateRouteSource,
    /createFallbackWorkbook\(await buildReadyRows\(month, year, access(?:, batchId)?\), month, year, \{ formulas: true \}\)/,
    "Ready payroll download must create the workbook with Excel formulas enabled.",
  );

  assert.match(
    readyProrationSource,
    /export function calculateNetJoinerProrationDeduction/,
    "Ready payroll must calculate the joiner proration deduction against NET (owner instruction 2026-08-29).",
  );
  assert.doesNotMatch(
    readyProrationSource,
    /export function calculateBaseProrationDeduction/,
    "the retired base-only joiner deduction must stay deleted — leaving it beside the live one is how the old rule gets called back into service",
  );

  assert.match(
    templateRouteSource,
    /getEmployeeDirectoryRows\(\{ includeInactive: true \}\)/,
    "Ready payroll must include inactive directory rows so current-month resignations can be paid.",
  );

  assert.match(
    templateRouteSource,
    /terminalPayrollStatuses = new Set\(\["resigned", "terminated", "inactive"\]\)/,
    "Ready payroll must identify terminal employees for final-month payroll inclusion.",
  );

  // Resignation Rule 1 is DATE-dependent, so the allowances must never be decided by
  // isTerminalPayroll alone. That unconditional zeroing was the bug: a leaver after the
  // 25th is owed ECOL and Fuel IN FULL, and this assertion used to demand the opposite.
  assert.doesNotMatch(
    templateRouteSource,
    /extraCostOfLiving = payrollEmployee\.isTerminalPayroll \? 0/,
    "extra cost of living must not be zeroed for every leaver — after the 25th it is paid in full",
  );
  assert.doesNotMatch(
    templateRouteSource,
    /fuelAllowance = payrollEmployee\.isTerminalPayroll \? 0/,
    "fuel allowance must not be zeroed for every leaver — after the 25th it is paid in full",
  );
  assert.equal(
    (templateRouteSource.match(/resolveReadyLifecycleSettlement\(\{/g) ?? []).length,
    2,
    "BOTH sheet builders (upload and Ready) must derive Base, ECOL and Fuel from the one settlement, or the two sheets state different rules",
  );
  assert.match(
    templateRouteSource,
    /const extraCostOfLiving = settlement\.extraCostOfLiving;/,
    "ECOL must come from the settlement that applied Resignation Rule 1",
  );
  assert.match(
    templateRouteSource,
    /const fuelAllowance = settlement\.fuelAllowance;/,
    "Fuel must come from the same settlement, so the two allowances can never disagree about the branch",
  );
  assert.match(
    readyProrationSource,
    /export function resolveReadyLifecycleSettlement/,
    "the >25th resignation rule must live in the pure module, where it can be asserted without ExcelJS or Supabase",
  );

  // Finding #1 (risk-review; owner ruling 2026-08-14): Rule 1's >25th full-pay waiver is for
  // GENUINE resignations only. Both settlement calls must pass the resignation flag, and the
  // terminal mapping must derive it from the "resigned" status — terminated (dismissed) and
  // inactive (deactivated) leavers must NOT earn the waiver.
  assert.equal(
    (templateRouteSource.match(/isResignation: payrollEmployee\.isResignation/g) ?? []).length,
    2,
    "BOTH sheet builders must pass the resignation flag into the settlement, or a dismissal silently earns the >25th full-pay rule",
  );
  assert.match(
    templateRouteSource,
    /isResignation:\s*normalizePayrollStatus\(employee\.employmentStatus\) === resignationPayrollStatus/,
    "only a 'resigned' terminal employee is a genuine resignation — terminated/inactive must not be",
  );
  assert.match(
    templateRouteSource,
    /const resignationPayrollStatus = "resigned"/,
    "the resignation status token must be pinned so the gate cannot silently widen back to all leavers",
  );

  // Finding #2 (risk-review): the Ready sheet's Net Salary must be derived from the SETTLEMENT
  // allowances (0 for a leaver who keeps none), matching the col-13 formula base+ECOL+Fuel.
  // fixedSalary.netSalary carries the full standard allowances, so caching it inflated a leaver's
  // Month Salary by the very ECOL/Fuel the same row shows as zero — and tripped the net-salary
  // mismatch guard on a raw re-upload.
  assert.equal(
    (templateRouteSource.match(/const netSalary = money\(baseSalary \+ extraCostOfLiving \+ fuelAllowance\)/g) ?? []).length,
    2,
    "BOTH sheet builders must derive Net Salary from the settlement allowances, so the stored figure equals its own base+ECOL+Fuel formula",
  );
  assert.doesNotMatch(
    templateRouteSource,
    /const netSalary = money\(fixedSalary\.netSalary\)/,
    "Net Salary must NOT be the full-allowance fixedSalary.netSalary — that inflates a leaver's Month Salary by the ECOL/Fuel the same row zeroes",
  );

  // The workbook's Other Deductions formula must reuse the settlement's effective end day, not
  // recompute a >25th waiver blind to the resignation flag — recomputing would re-waive a
  // dismissal to month end on Excel recalc and re-introduce the overpayment finding #1 fixes.
  assert.match(
    templateRouteSource,
    /const endDay = row\.effectiveEndDay;/,
    "the Other Deductions formula must use the row's settled effective end day, so a dismissal is charged to its real last working day",
  );

  assert.match(
    readyProrationSource,
    /export function calculateBaseLifecycleProrationDeduction/,
    "Ready payroll must prorate final-month salary through the last working date.",
  );

  assert.match(
    templateRouteSource,
    /function payrollExcelDateOnly/,
    "Ready payroll must normalize date-only values before writing them to Excel.",
  );

  assert.match(
    templateRouteSource,
    /Date\.UTC\([\s\S]*?date\.getFullYear\(\)[\s\S]*?date\.getMonth\(\)[\s\S]*?date\.getDate\(\)[\s\S]*?12[\s\S]*?\)/,
    "Ready payroll must write Hire Date at UTC noon so Excel does not shift it one day earlier.",
  );

  assert.match(
    readyProrationSource,
    /daysInMonth - hireDay \+ 1/,
    "Ready payroll proration must include the hire date, counted against the real month length.",
  );

  // This assertion used to read /30 - hireDay \+ 1/ and its message asserted a
  // "fixed 30-day month" was correct. That is the defect it was meant to guard:
  // a 28-day February can never satisfy `endDay >= 30`, so a leaver dated 28 Feb
  // who worked every day was charged 2 days of salary. Pin the absence of the
  // hardcoded divisor so it cannot come back.
  assert.doesNotMatch(
    readyProrationSource,
    /\/ 30\)|\/30\)|>= 30\b|Math\.min\(30\b/,
    "Ready payroll proration must never reintroduce a hardcoded 30-day month.",
  );

  assert.doesNotMatch(
    templateRouteSource,
    /\$\{baseSalary\}\/30/,
    "The workbook's Other Deductions formula must divide by the real month length, not a literal 30 — the sheet recalculates client-side and would otherwise disagree with the stored figure.",
  );

  assert.match(
    templateRouteSource,
    /IF\(AND\(ISNUMBER\(\$\{hireDate\}\),YEAR\(\$\{hireDate\}\)=\$\{year\},MONTH\(\$\{hireDate\}\)=\$\{month\}\)/,
    "Ready payroll Other Deductions must contain the hire-month proration formula.",
  );

  // The workbook recalculates client-side, so the JOINER branch of the formula has to
  // divide the same thing calculateNetJoinerProrationDeduction divides. If it reverted to
  // base-only, the downloaded sheet would quietly restate every new hire's pay upward and
  // disagree with the figure Ready Payroll stored — the exact class of drift this file exists
  // to catch. The leaver branch is deliberately excluded: it still divides Base alone.
  assert.match(
    templateRouteSource,
    /const netSalary = `\(\$\{baseSalary\}\+\$\{cellRef\(rowNumber, 18\)\}\+\$\{cellRef\(rowNumber, 19\)\}\)`/,
    "the formula's Net must be built from Base (col 11) + Extra Cost of Living (col 18) + Fuel (col 19)",
  );
  assert.match(
    templateRouteSource,
    /\$\{netSalary\}-\(\(\$\{netSalary\}\/\$\{daysInMonth\}\)\*MAX\(0,\$\{daysInMonth\}-DAY\(\$\{hireDate\}\)\+1\)\)/,
    "the joiner branch must prorate NET across the real month length",
  );
  assert.doesNotMatch(
    templateRouteSource,
    /\$\{baseSalary\}-\(\(\$\{baseSalary\}\/\$\{daysInMonth\}\)\*MAX\(0,\$\{daysInMonth\}-DAY\(\$\{hireDate\}\)\+1\)\)/,
    "the joiner branch must NOT divide Base alone — that is the retired rule, and it pays a mid-month hire more than the owner set",
  );

  assert.match(
    templateRouteSource,
    /ROUND\(\$\{baseSalary\}\+\$\{socialInsurance\}\+\$\{employmentIncomeTax\},2\)/,
    "Ready payroll Gross Salary must be an Excel formula.",
  );

  assert.match(
    templateRouteSource,
    /ROUND\(\$\{baseSalary\}\+\$\{extraCostOfLiving\}\+\$\{fuelAllowance\},2\)/,
    "Ready payroll Net Salary must be an Excel formula.",
  );

  assert.match(
    templateRouteSource,
    /IF\(\$\{paymentMode\}="One Part",MAX\(0,\$\{monthSalary\}-MIN\(MAX\(0,\$\{monthSalary\}\),MAX\(0,\$\{expenses\}\+\$\{incentive\}\)\)\),MIN\(MAX\(0,\$\{monthSalary\}-MIN\(MAX\(0,\$\{monthSalary\}\),MAX\(0,\$\{expenses\}\+\$\{incentive\}\)\)\),ROUND\(\$\{baseSalary\}\*\$\{BASIC_SALARY_RATE\},2\),MAX\(0,\$\{baseSalary\}-\$\{otherDeductions\}\)\)\)/,
    "Ready payroll First Part must exclude expenses and incentive before applying One Part or Two Parts caps.",
  );

  // The basic-salary rate is owner-locked in src/lib/payroll/policy.ts. This file may READ it,
  // never restate it: a second copy of 0.7 is a second source of truth for a number the owner
  // keeps under lock, and the Excel formula, the TS split and the sheet's own prose had all
  // drifted into carrying their own. The emitted workbook text is unchanged (0.7 either way).
  assert.doesNotMatch(
    templateRouteSource,
    /\*\s*0\.7\b/,
    "the payroll template must not multiply by a hardcoded 0.7 — import BASIC_SALARY_RATE from the locked policy module",
  );
  assert.doesNotMatch(
    templateRouteSource,
    /Base Salary x 70%|B5\*70%|Day 1: 70% of base/,
    "the sheet's own prose must not state a rate it did not compute with — derive the label from BASIC_SALARY_RATE",
  );
  assert.match(
    templateRouteSource,
    /BASIC_SALARY_RATE,?\s*$|BASIC_SALARY_RATE\b/m,
    "the template must import the locked BASIC_SALARY_RATE rather than restating it",
  );

  assert.match(
    templateRouteSource,
    /IF\(\$\{paymentMode\}="One Part",MIN\(MAX\(0,\$\{monthSalary\}\),MAX\(0,\$\{expenses\}\+\$\{incentive\}\)\),MAX\(0,ROUND\(\$\{monthSalary\}-\$\{firstPart\},2\)\)\)/,
    "Ready payroll Second Part must include expenses and incentive for One Part rows and never be negative.",
  );

  assert.match(
    templateRouteSource,
    /function sortReadyPayrollRows/,
    "Ready payroll must group rows into deterministic payroll blocks.",
  );

  assert.match(
    templateRouteSource,
    /function readyPayrollBlockRank/,
    "Ready payroll must have an explicit block ranking function.",
  );

  assert.match(
    templateRouteSource,
    /row\.paymentMode === "One Part"[\s\S]*?return 1/,
    "Ready payroll must keep One Part rows in the first block.",
  );

  assert.match(
    templateRouteSource,
    /payrollMonthMatches\(row\.hireDate, row\.month, row\.year\)[\s\S]*?return 3/,
    "Ready payroll must put current-month Two Parts new hires below already hired rows.",
  );

  assert.match(
    templateRouteSource,
    /payrollMonthMatches\(row\.lastWorkingDate, row\.month, row\.year\)[\s\S]*?return 4/,
    "Ready payroll must put current-month resignation rows in the final block.",
  );

  assert.match(
    templateRouteSource,
    /readyPayrollBlockDateSortValue\(left\) -\s*readyPayrollBlockDateSortValue\(right\)/,
    "Ready payroll rows inside each block must be sorted from oldest to newest.",
  );

  assert.match(
    templateRouteSource,
    /readyPayrollEditableColumnNumbers = new Set\(\[[\s\S]*?14, 15, 16, 17, 20,[\s\S]*?25, 26, 27, 28, 29, 30,[\s\S]*?\]\)/,
    "Ready payroll must leave monthly additions and deductions editable.",
  );

  assert.match(
    templateRouteSource,
    /locked: !readyPayrollEditableColumnNumbers\.has\(column\)/,
    "Ready payroll protection must lock fixed fields while allowing edits to variable fields.",
  );

  assert.match(
    templateRouteSource,
    /function writeReadyPayrollBlockHeaderRow/,
    "Ready payroll must write visible block header rows.",
  );

  assert.match(
    templateRouteSource,
    /BLOCK 1 - One Part[\s\S]*?BLOCK 2 - Two Parts Already Hired[\s\S]*?BLOCK 3 - New Hires[\s\S]*?BLOCK 4 - Resignations/,
    "Ready payroll must label the four requested blocks.",
  );

  assert.match(
    templateRouteSource,
    /blockHeaderRows\.add\(rowNumber\)/,
    "Ready payroll must track block header rows separately from employee data rows.",
  );

  assert.match(
    templateRouteSource,
    /from: \{ column: 1, row: dataStartRow - 1 \}/,
    "Ready payroll AutoFilter must keep the main workbook header as the filter header.",
  );

  assert.match(
    salaryImportSource,
    /function isReadyPayrollBlockHeaderRow/,
    "Payroll upload parsing must identify ready-payroll block separator rows.",
  );

  assert.match(
    salaryImportSource,
    /!isReadyPayrollBlockHeaderRow\(row\)/,
    "Payroll upload parsing must skip ready-payroll block separator rows.",
  );

  assert.match(
    templateRouteSource,
    /await sheet\.protect\("",/,
    "Ready payroll must protect the sheet so the One Part fixed block does not move during normal sorting.",
  );
}
