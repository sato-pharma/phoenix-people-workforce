/**
 * Does anything INDEPENDENT of the CRM clear a half day — and does the field force punch a device?
 *
 * 🔴 IT READS, IT NEVER WRITES, AND IT EXITS 0 WHATEVER IT FINDS. A half day is money. Nothing in
 * this file raises, clears, re-dates or retracts a deduction, and nothing here is a verdict about a
 * person: the decision is the owner's, on the deductions screen. This answers one question about the
 * EVIDENCE the half-day rule stands on.
 *
 * ## The question
 *
 * `judgeHalfDay` charges a half day when exactly one half of a working day is covered — and clears it
 * when a "trace" shows the missing half was worked (`morningProof` / `eveningProof`,
 * src/lib/deductions/half-day-rule.ts). Two things can raise that proof:
 *
 *   1. an iReports360 GPS CHECK-IN, recorded by the old app at a customer — independent of whatever
 *      the rep later typed, and the only outside witness in the whole rule;
 *   2. the visit's own `crm_save_date` — the hour he pressed Save. That is not an independent trace
 *      at all: it is the same action as the visit, timed by the tap that created it.
 *
 * As Phoenix CRM replaces iReports360 team by team, (1) disappears for a started team and (2) is
 * what is left. So this prints, for one month, the person-days where the ONLY thing standing between
 * a half day and a clearance is the rep's own save time.
 *
 * ## Why not compare against the attendance punches, which is what the audit asked for
 *
 * Because there is nothing to compare with. Measured on production for 2026-10 (and the script
 * re-measures it every run rather than trusting this line): the device punch feed is alive and
 * current, but only ~15 people are on it and every one of them is head office — admin, HR, product
 * and national managers, the SFE Manager. **No medical rep and no district manager punches a device
 * at all.** A "CRM visit versus the punches" check would compare the whole field force against an
 * empty set and read green forever, which is worse than no check.
 *
 * ## How the two runs work, so no rule is re-implemented here
 *
 * `buildHalfDayEvidence` is called TWICE, unchanged (`never-hand-roll-a-rule-the-repo-already-implements`):
 *
 *   · run A — the real visits and the real check-ins, exactly as the connector calls it;
 *   · run B — the real visits and NO check-ins.
 *
 * Check-ins feed nothing but the proofs, and AM/PM placement reads the visit row alone, so a proof
 * that survives into run B came from inside the CRM, and a proof that only exists in run A had an
 * outside witness. Nothing else distinguishes them, and neither run touches the database twice.
 *
 * WHAT THIS IS NOT. It applies no vacation cover, no national holiday, no ledger conflict and no
 * employment window — only the Friday and Thursday drops the rule itself applies. A day printed here
 * is a day whose CLEARING TRACE IS NOT INDEPENDENT; it is not a half day, not a candidate, and not a
 * charge. Read the deductions screen for those.
 *
 * Usage (from the repo root, with a populated .env.local — this READS PRODUCTION):
 *   node --env-file=.env.local --experimental-strip-types \
 *     --experimental-specifier-resolution=node --experimental-loader ./tests/alias-loader.mjs \
 *     scripts/check-half-day-trace-independence.ts [YYYY-MM] [--all-days] [--limit N]
 */
import { queryCheckins, scanVisitsForRangeIncludingDeparted } from "@/lib/crm/reads";
import { compactDeductionsHrId } from "@/lib/deductions/candidate-key";
import {
  buildHalfDayEvidence,
  buildHalfDayIdentity,
  halfDayContractOf,
  halfOutsideContract,
  type HalfDayCheckinRow,
  type HalfDayEvidence,
  type HalfDayVisitRow,
} from "@/lib/deductions/half-day-rule";
import { isFieldForceWorkingDay } from "@/lib/deductions/holiday-bridge";
import { isFieldWorkforceThursday } from "@/lib/field-workforce-compliance/weekend-policy";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { assertTreeIsCurrent } from "./lib/tree-is-current.ts";

const VISIT_COLUMNS =
  "visit_date, visit_type, ampm, crm_save_date, agent_hr_id, agent_crm_id, double_hr_id, double_crm_id, double2_hr_id, double2_crm_id, contact_crm_id, source, lat, lon";

const argv = process.argv.slice(2);
const allDays = argv.includes("--all-days");
const limitArg = argv.indexOf("--limit");
const limit = limitArg >= 0 ? Number(argv[limitArg + 1] ?? "40") : 40;
const months = argv.filter((arg) => /^\d{4}-\d{2}$/.test(arg));
// An unknown flag is REFUSED rather than ignored: an ignored flag runs behaviour the operator did
// not ask for while reporting success.
const unknown = argv.filter((arg, index) => arg.startsWith("-") && arg !== "--all-days" && arg !== "--limit" && argv[index - 1] !== "--limit");
if (unknown.length > 0) {
  console.error(`Unknown flag(s): ${unknown.join(" ")}`);
  process.exit(2);
}
if (!Number.isFinite(limit) || limit < 1) {
  console.error("--limit takes a positive whole number of rows.");
  process.exit(2);
}

/** The Cairo month, since every date in this module is a Cairo business day. */
function currentCairoMonth(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" }).slice(0, 7);
}

function monthWindow(month: string): { start: string; end: string } {
  const [year, index] = month.split("-").map(Number);
  const last = new Date(Date.UTC(year, index, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, "0")}` };
}

function addDay(dateIso: string): string {
  const date = new Date(`${dateIso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/** Which half is missing, when exactly one is — the only shape `judgeHalfDay` can charge. */
function missingHalf(evidence: HalfDayEvidence): "AM" | "PM" | null {
  if (evidence.crmLeave || evidence.unattributedRow) return null;
  if (evidence.am === evidence.pm) return null;
  return evidence.am ? "PM" : "AM";
}

function proofFor(evidence: HalfDayEvidence, missing: "AM" | "PM"): boolean {
  return missing === "AM" ? evidence.morningProof : evidence.eveningProof;
}

async function main(): Promise<void> {
  assertTreeIsCurrent("check-half-day-trace-independence");
  const month = months[0] ?? currentCairoMonth();
  const { start, end } = monthWindow(month);
  const supabase = getSupabaseAdmin();

  // 🔴 The project ref is PRINTED before anything is read (AGENTS.md §8) — the one thing separating
  // production from staging on every call is which URL the environment holds.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
  console.log(`Supabase project: ${url.replace(/^https?:\/\//, "").split(".")[0] || "UNKNOWN"}   month: ${month} (${start} → ${end}, Cairo)`);
  console.log("READ-ONLY. Nothing here raises, clears or re-dates a deduction.\n");

  const [visits, checkins, employees, punches] = await Promise.all([
    scanVisitsForRangeIncludingDeparted<HalfDayVisitRow>({ dateFrom: start, dateTo: end, columns: VISIT_COLUMNS }),
    // The connector's own call: iReports360 check-ins only (`queryCheckins` filters on `source`
    // unless a caller asks for the Phoenix rows, and the half-day connector does not ask).
    queryCheckins<HalfDayCheckinRow>({
      columns: "agent_hr_id, agent_crm_id, contact_crm_id, check_date",
      dateFrom: start,
      dateTo: addDay(end),
      includeResignedAgents: true,
    }),
    // Both paged: one read stops silently at 1,000 rows, and a missing punch reads as "never punches".
    fetchAllRows<{ hr_id: unknown; full_name: unknown; job_title: unknown; crm_id: unknown; work_half: unknown }>(
      () => supabase.from("employees").select("hr_id, full_name, job_title, crm_id, employment_status, work_half"),
      "hr_id",
    ),
    fetchAllRows<{ employee_hr_id: unknown }>(
      () =>
        supabase
          .from("attendance_raw_punches")
          .select("employee_hr_id")
          .not("employee_hr_id", "is", null)
          .gte("punch_time", `${start}T00:00:00`)
          .lt("punch_time", `${addDay(end)}T00:00:00`),
      "id",
    ),
  ]);

  const nameOf = new Map<string, string>();
  const titleOf = new Map<string, string>();
  const contractOf = new Map<string, "full_day" | "am_only" | "pm_only">();
  for (const row of employees) {
    const compact = compactDeductionsHrId(String(row.hr_id ?? ""));
    if (!compact) continue;
    nameOf.set(compact, String(row.full_name ?? row.hr_id));
    titleOf.set(compact, String(row.job_title ?? ""));
    contractOf.set(compact, halfDayContractOf(row.work_half));
  }

  const punchedBy = new Set<string>();
  for (const row of punches) {
    const compact = compactDeductionsHrId(String(row.employee_hr_id ?? ""));
    if (compact) punchedBy.add(compact);
  }

  const identity = buildHalfDayIdentity([
    ...employees.map((row) => ({ hrId: row.hr_id, crmId: row.crm_id })),
    ...visits.map((row) => ({ hrId: row.agent_hr_id, crmId: row.agent_crm_id })),
    ...visits.map((row) => ({ hrId: row.double_hr_id, crmId: row.double_crm_id })),
    ...visits.map((row) => ({ hrId: row.double2_hr_id, crmId: row.double2_crm_id })),
  ]);

  // Run A is the connector's own call. Run B removes the only outside witness and nothing else.
  const withWitness = buildHalfDayEvidence({ visits, checkins, identity });
  const withoutWitness = buildHalfDayEvidence({ visits, checkins: [], identity });

  type Finding = { compact: string; date: string; missing: "AM" | "PM"; phoenix: boolean };
  const selfCleared: Finding[] = [];
  let oneHalfDays = 0;
  let clearedIndependently = 0;
  let outsideContract = 0;
  const noTrace: Finding[] = [];
  const phoenixDays = new Set<string>();
  const peopleWithActivity = new Set<string>();

  const phoenixVisitDays = new Set<string>();
  for (const row of visits) {
    if (String(row.source ?? "").trim().toLowerCase() !== "phoenix") continue;
    phoenixVisitDays.add(`${compactDeductionsHrId(String(row.agent_hr_id ?? ""))}:${String(row.visit_date ?? "").slice(0, 10)}`);
  }

  for (const [key, evidence] of withWitness.byPersonDay) {
    const [compact, date] = key.split(":");
    if (!compact || !date) continue;
    peopleWithActivity.add(compact);
    if (!allDays && (!isFieldForceWorkingDay(date) || isFieldWorkforceThursday(date))) continue;
    const missing = missingHalf(evidence);
    if (!missing) continue;
    // 🔴 A half the contract does not cover was never owed, so it is not a thin-evidence day and
    // the live rule leaves it alone (`outside_contract_half`). Counting it here would report a
    // part-timer's every working day as a morning he failed to record.
    if (missing === halfOutsideContract(contractOf.get(compact) ?? "full_day")) {
      outsideContract += 1;
      continue;
    }
    oneHalfDays += 1;
    const proven = proofFor(evidence, missing);
    if (!proven) {
      noTrace.push({ compact, date, missing, phoenix: phoenixVisitDays.has(key) });
      continue;
    }
    const provenWithoutWitness = proofFor(withoutWitness.byPersonDay.get(key) ?? evidence, missing);
    if (provenWithoutWitness) {
      const phoenix = phoenixVisitDays.has(key);
      selfCleared.push({ compact, date, missing, phoenix });
      if (phoenix) phoenixDays.add(key);
    } else {
      clearedIndependently += 1;
    }
  }

  const fieldPeople = [...peopleWithActivity].filter((compact) => !punchedBy.has(compact));
  console.log("── The device punches ──────────────────────────────────────────────────────────");
  console.log(`CRM-active people this month:            ${peopleWithActivity.size}`);
  console.log(`…of them with at least one punch:        ${peopleWithActivity.size - fieldPeople.length}`);
  console.log(`…of them with NO punch at all:           ${fieldPeople.length}`);
  console.log(`Everyone on the punch feed this month:   ${punchedBy.size}`);
  console.log(
    fieldPeople.length === peopleWithActivity.size
      ? "A CRM-visit-versus-punch check would compare EVERY one of them against an empty set.\n"
      : "A CRM-visit-versus-punch check would cover only the few above, and none of the rest.\n",
  );

  console.log("── What clears a half ─────────────────────────────────────────────────────────");
  console.log(`Visits read: ${visits.length}   iReports360 check-ins read: ${checkins.length}`);
  console.log(`Person-days with exactly one half covered: ${oneHalfDays}`);
  console.log(`  cleared by an INDEPENDENT iReports360 check-in: ${clearedIndependently}`);
  console.log(`  cleared ONLY by the rep's own save time:        ${selfCleared.length}  (${phoenixDays.size} of them on Phoenix visits)`);
  console.log(`  not cleared by any trace:                      ${noTrace.length}`);
  console.log(
    `Person-days left alone because the half is OUTSIDE the contract: ${outsideContract}`
    + "  (a part-half contract never owed that half)",
  );

  if (selfCleared.length > 0) {
    console.log("\nThe days whose clearing trace is not independent (name · day · missing half · source):");
    selfCleared.sort((a, b) => (a.date === b.date ? a.compact.localeCompare(b.compact) : a.date.localeCompare(b.date)));
    for (const finding of selfCleared.slice(0, limit)) {
      const who = nameOf.get(finding.compact) ?? finding.compact;
      const title = titleOf.get(finding.compact);
      console.log(`  ${finding.date}  ${who}${title ? ` (${title})` : ""}  missing ${finding.missing}  ${finding.phoenix ? "Phoenix" : "iReports360"}`);
    }
    if (selfCleared.length > limit) console.log(`  … and ${selfCleared.length - limit} more (--limit ${selfCleared.length} to print them all)`);
  }

  // 🔴 This is the group the live rule actually RAISES, so it is named and not merely counted. It
  // was a bare number until 2026-10-12, which made the report read as though the weakly-cleared
  // days were its finding — they are the safer half of it.
  if (noTrace.length > 0) {
    console.log("");
    console.log("The days no trace clears at all — what the rule would raise (name · day · missing half · source):");
    noTrace.sort((a, b) => (a.date === b.date ? a.compact.localeCompare(b.compact) : a.date.localeCompare(b.date)));
    for (const finding of noTrace.slice(0, limit)) {
      const who = nameOf.get(finding.compact) ?? finding.compact;
      const title = titleOf.get(finding.compact);
      console.log(`  ${finding.date}  ${who}${title ? ` (${title})` : ""}  missing ${finding.missing}  ${finding.phoenix ? "Phoenix" : "iReports360"}`);
    }
    if (noTrace.length > limit) console.log(`  … and ${noTrace.length - limit} more (--limit ${noTrace.length} to print them all)`);
  }

  console.log(
    "\nREMINDER: this is a reading of the evidence, not of anybody's month. No vacation cover, national" +
      "\nholiday, ledger conflict or employment window is applied here, and nothing above is a half day" +
      "\nor a charge. The deductions screen is where a half day is decided.",
  );
}

await main();
