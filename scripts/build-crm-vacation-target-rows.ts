/**
 * Builds the `target-rows.json` that `scripts/import-crm-vacation-backfill.ts` consumes.
 *
 * WHY THIS EXISTS. The importer deliberately takes a frozen, pre-reviewed row list and never
 * derives one: each row becomes an APPROVED leave day on a real person's record, and the
 * 2026-08-24 run put one 167 days before an employee's hire date because a CRM account is a seat
 * the vendor renames to its next occupant. Until now that list was produced by hand, outside the
 * repository, which is why no September list exists and why the working-day rules behind the
 * August one cannot be re-read anywhere.
 *
 * So the derivation lives here, in code, reusing the engines that already own each rule rather
 * than restating any of them:
 *
 *   · WHICH DAYS ARE CRM LEAVE — `buildFieldWorkforceCompliancePreviewFromVisitsReport`, the engine
 *     automated payroll's own CRM-leave loader used to read (both it and the
 *     `computeVacationDeductionTotals` above it were deleted on 2026-10-01, once this importer
 *     became the one path a CRM leave day reaches a balance by and nothing could reach them any
 *     more — so this script is now that engine's only reader on the leave path). Annual Vacation (-4) maps to
 *     "AV" and surfaces as a `vacation_signal` review candidate. Fridays, future days, ineligible
 *     titles and the public-holiday calendar are already applied there; it REFUSES outright when
 *     the holiday calendar cannot be read, so a holiday can never be mistaken for a working day.
 *   · WHAT ONE DAY IS WORTH — `fieldWorkforceDeductionDayWeight`: 0 on a weekly off (Friday, and
 *     Saturday for anyone who is not a Friday-only title), 0.5 on a Thursday (owner rule
 *     2026-08-02 — the field week is Saturday-Wednesday full, Thursday AM only), 1 otherwise. A
 *     0-weight day is dropped rather than imported.
 *   · WHICH DAYS ARE ALREADY IN PHOENIX — `v2_vacation_requests` in `approved`/`pending_manager`,
 *     the exact statuses the balance engine counts. The importer re-checks this per row with a
 *     containment query; this pass only keeps the list honest before a human reads it.
 *
 * It WRITES NOTHING but the JSON file, reads production through the service role, and prints the
 * counts plus every exclusion with its reason so the list can be reviewed rather than trusted.
 *
 * Usage:
 *   node --env-file-if-exists=.env.local --experimental-strip-types \
 *     --experimental-specifier-resolution=node --experimental-loader ./scripts/alias-loader.mjs \
 *     scripts/build-crm-vacation-target-rows.ts --month 9 --year 2026 --out <path>
 */
import fs from "node:fs";

import { getEmployeeDirectory, isActiveLifecycleStatus } from "@/lib/employees/employee-directory";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { buildFieldWorkforceCompliancePreviewFromVisitsReport } from "@/lib/field-workforce-compliance/ireports360-source";
import { fieldWorkforceDeductionDayWeight } from "@/lib/field-workforce-compliance/weekend-policy";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "build-crm-vacation-target-rows",
  entry: import.meta.url,
  known: ["--month", "--year", "--out"],
});

/**
 * Excluded from every CRM vacation backfill by owner decision, carried over from the 2026-08-03
 * run's input. Kept as a named constant so the exclusion is visible in the output rather than
 * buried in a filter.
 */
const EXCLUDED_HR_IDS = new Set(["b14"]);

type TargetRow = {
  date: string;
  dayPart: string;
  detail: string;
  hrId: string;
  name: string;
  workingDays: number;
};

type Dropped = { date: string; hrId: string; name: string; reason: string };

function readArg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

const month = Number(readArg("--month"));
const year = Number(readArg("--year"));
const outPath = readArg("--out");

if (!Number.isInteger(month) || month < 1 || month > 12) throw new Error("--month <1-12> is required.");
if (!Number.isInteger(year) || year < 2000) throw new Error("--year <YYYY> is required.");
if (!outPath) throw new Error("--out <path to target-rows.json> is required.");

const periodLabel = `${year}-${String(month).padStart(2, "0")}`;
console.log(`Building CRM vacation target rows for ${periodLabel}`);

// 1) The CRM leave days themselves. This throws rather than returning an empty set when the
//    visits mirror or the Egypt holiday calendar cannot be read — a refusal, never a quiet zero.
const preview = await buildFieldWorkforceCompliancePreviewFromVisitsReport({ month, year });
if (preview.metadata?.holidayCalendarReachable === false || preview.metadata?.holidayConnected === false) {
  throw new Error(
    "The Egypt national-holiday calendar could not be read. Refusing to build a list: an unconfirmed "
      + "holiday would be imported as an ordinary leave day and taken off someone's balance.",
  );
}

const signals = preview.reviewCandidates.filter(
  (candidate) => candidate.type === "vacation_signal" && candidate.dateIso,
);
console.log(`  CRM vacation signals in the compliance matrix: ${signals.length}`);

// 2) Days Phoenix already knows about, in the statuses the balance engine counts.
const monthEnd = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
const monthStart = `${periodLabel}-01`;
// Paged: a request missed by a single read would be imported again as a second leave day.
const supabase = getSupabaseAdmin();
const existing = await fetchAllRows<{ employee_hr_id: string | null; start_date: string; end_date: string }>(
  () =>
    supabase
      .from("v2_vacation_requests")
      .select("employee_hr_id,start_date,end_date")
      .in("status", ["approved", "pending_manager"])
      .lte("start_date", monthEnd)
      .gte("end_date", monthStart),
  "id",
).catch((error: { message?: string }) => {
  throw new Error(`Could not read existing vacation requests: ${error.message ?? String(error)}`);
});

const coveredDates = new Set<string>();
for (const row of existing) {
  const key = canonicalHrIdKey(row.employee_hr_id ?? "");
  if (!key) continue;
  for (let d = new Date(`${row.start_date}T00:00:00Z`); d <= new Date(`${row.end_date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    coveredDates.add(`${key}|${d.toISOString().slice(0, 10)}`);
  }
}
console.log(`  existing approved/pending-manager leave day-keys in the period: ${coveredDates.size}`);

// 3) Identity, employment status and job title — the title decides the day's weight.
const directory = await getEmployeeDirectory();
const byKey = new Map(directory.employees.map((employee) => [canonicalHrIdKey(employee.hrId), employee]));

const rows: TargetRow[] = [];
const dropped: Dropped[] = [];

for (const signal of signals) {
  const key = canonicalHrIdKey(signal.hrId);
  const dateIso = String(signal.dateIso);
  const employee = key ? byKey.get(key) : undefined;
  const name = employee?.fullName || signal.hrId;
  const push = (reason: string) => dropped.push({ date: dateIso, hrId: signal.hrId, name, reason });

  if (!key) { push("unresolvable HR id"); continue; }
  if (EXCLUDED_HR_IDS.has(key)) { push("excluded by owner decision"); continue; }
  if (!employee) { push("no employee record"); continue; }
  if (!isActiveLifecycleStatus(employee.employmentStatus)) {
    push(`not active (${employee.employmentStatus ?? "unknown"})`);
    continue;
  }
  if (coveredDates.has(`${key}|${dateIso}`)) { push("already covered by a Phoenix request"); continue; }

  const weight = fieldWorkforceDeductionDayWeight({ dateIso, title: employee.jobTitle });
  if (weight === 0) { push("weekly off for this title"); continue; }

  rows.push({
    date: dateIso,
    // Thursday is AM-only for the field workforce, so leave on one consumes the morning half.
    dayPart: weight === 1 ? "full_day" : "am_only",
    detail: `Annual Vacation (-4) recorded in iReports360 on ${dateIso}`,
    hrId: employee.hrId,
    name,
    workingDays: weight,
  });
}

rows.sort((left, right) => (left.date === right.date ? left.hrId.localeCompare(right.hrId) : left.date.localeCompare(right.date)));

const totalDays = rows.reduce((sum, row) => sum + row.workingDays, 0);
const people = new Set(rows.map((row) => canonicalHrIdKey(row.hrId))).size;

fs.writeFileSync(outPath, `${JSON.stringify(rows, null, 2)}\n`, "utf8");

console.log("");
console.log(`WROTE ${outPath}`);
console.log(`  rows            ${rows.length}`);
console.log(`  weighted days   ${totalDays}`);
console.log(`  people          ${people}`);
console.log(`  half days (Thu) ${rows.filter((row) => row.workingDays === 0.5).length}`);
console.log("");
console.log(`DROPPED ${dropped.length}:`);
const byReason = new Map<string, number>();
for (const drop of dropped) byReason.set(drop.reason, (byReason.get(drop.reason) ?? 0) + 1);
for (const [reason, count] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(4)}  ${reason}`);
}
