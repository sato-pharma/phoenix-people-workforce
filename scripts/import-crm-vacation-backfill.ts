/**
 * ONE-OFF OPS SCRIPT — CRM vacation signal backfill into Phoenix.
 *
 * Owner-approved 2026-08-03. Converts the reviewed set of CRM "Annual Vacation" days that have no
 * matching Phoenix leave request into real approved requests, so employee balances stop
 * under-counting leave that the CRM already recorded.
 *
 * Deliberately reuses createVacationRequestAsAdmin — the SAME balance engine the admin UI and the
 * Company Vacation Report's per-row approve route use — rather than writing rows with raw SQL.
 * Raw inserts bypass the balance calculation and are what produced the broken balance chain on
 * A-7's earlier legacy backfill. It also replicates the two guards the approve route applies
 * before writing: national-holiday adjacency, and overlap containment against an existing request
 * (the double-deduction defence — the DB unique index only catches an EXACT date-tuple collision,
 * not an existing wider range that already contains this date).
 *
 * A third guard runs BEFORE both of those and is this script's own: the leave must be able to
 * belong to the employee it names. The 2026-08-24 run gave PD-0009 an approved row dated 167 days
 * before his hire date, because a CRM account is a seat the vendor renames to its next occupant and
 * a re-sync stamps old visits with the current name. src/lib/vacation/backfill-guards.ts carries
 * the account.
 *
 * The input is a frozen, pre-reviewed row list (target-rows.json) produced from the CRM/Phoenix
 * gap analysis with the working-day rules already applied: Thursdays count 0.5 for the field
 * workforce, Fridays are dropped, Saturdays are dropped for non-field titles, and the Eid al-Adha
 * company closure and Sinai Liberation Day are dropped. Resigned employees and B-14 are excluded.
 *
 * Usage:
 *   node --env-file-if-exists=.env.local --experimental-strip-types \
 *     --experimental-specifier-resolution=node --experimental-loader ./scripts/alias-loader.mjs \
 *     scripts/import-crm-vacation-backfill.ts --input <path> --marker <YYYY-MM-DD[-suffix]> [--execute] [--limit N]
 *
 * Without --execute it is a dry run: it resolves and guards every row but writes nothing.
 * `--marker` is this run's own date and is required — see the note on MARKER_PATTERN.
 */
import fs from "node:fs";

import { systemAccessContext } from "@/lib/auth/permissions";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { refuseLeaveBeforeHire } from "@/lib/vacation/backfill-guards";
import {
  createVacationRequestAsAdmin,
  validateOfficialHolidayAdjacency,
  vacationErrorMessage,
} from "@/lib/vacation/service";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "import-crm-vacation-backfill",
  entry: import.meta.url,
  known: ["--execute", "--input", "--limit", "--marker"],
});

/**
 * Stamped into every created row so the whole batch is identifiable and exactly reversible.
 *
 * IT IS A FLAG, NOT A HAND-EDITED CONSTANT, AND THAT IS THE WHOLE POINT.
 *
 * 🔴 CORRECTED 2026-10-01. An earlier version of this note said the 2026-08-03 and 2026-08-24 runs
 * shared one marker and could not be separated. THAT WAS WRONG, and measured wrong on production
 * the same day: the three batches are cleanly disjoint —
 * `[CRM_BACKFILL_2026-08-03]` 260 rows / 62 people, `[CRM_BACKFILL_2026-08-24]` 208 rows / 66
 * people, `[CRM_BACKFILL_2026-10-01]` 61 rows / 31 people. The constant was hand-edited before the
 * second run, so both August batches are reversible on their own.
 *
 * THE REAL DEFECT IS THE ONE THAT REMAINS, AND IT IS WHY THIS IS A FLAG. The constant was left
 * reading `2026-08-03` in the committed file after the 2026-08-24 run — a stale value that looks
 * deliberate. Editing it is a step someone has to remember, and the one time it mattered it was
 * forgotten: the NEXT run (September's) would have stamped its rows `2026-08-03` and folded them
 * silently into a batch from two months earlier. A required flag cannot be forgotten; a constant
 * that happens to be correct for one run cannot be relied on for the next.
 *
 * So the date must be passed and must be the date of THIS run (`--marker 2026-10-01`). The default
 * is deliberately absent rather than today's date: a default would be silently accepted, and a
 * batch marker that nobody chose is the same class of defect.
 *
 * 🔴 A DATE ALONE IS NOT ENOUGH, BECAUSE TWO BATCHES CAN RUN ON ONE DAY — found immediately, by
 * this change's own first use. The September 2026 import ran on 2026-10-01 and took
 * `[CRM_BACKFILL_2026-10-01]`; the August tail it had left behind was authorised minutes later, the
 * same day. A second run reusing that marker would have put 61 September rows and 12 August rows in
 * one bucket — precisely the inseparability this flag exists to prevent, reintroduced by the fix
 * for it.
 *
 * So an optional suffix is allowed: `--marker 2026-10-01-aug` stamps `[CRM_BACKFILL_2026-10-01-aug]`.
 * The date still leads, so markers sort chronologically and a batch still says when it ran; the
 * suffix only separates batches that share a day. It stays OPTIONAL rather than becoming required —
 * one batch on a day is the normal case and should not have to invent a name for itself.
 */
const MARKER_PATTERN = /^\d{4}-\d{2}-\d{2}(-[a-z0-9]{1,12})?$/;

type TargetRow = {
  date: string;
  dayPart: string;
  detail: string;
  hrId: string;
  name: string;
  workingDays: number;
};

type Outcome = {
  date: string;
  hrId: string;
  name: string;
  reason?: string;
  requestId?: string;
  status: "created" | "skipped_existing" | "failed" | "dry_run_ok";
  workingDays: number;
};

function readArg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

const execute = process.argv.includes("--execute");
const inputPath = readArg("--input");
const limitRaw = readArg("--limit");
const limit = limitRaw ? Number(limitRaw) : null;
const markerDate = readArg("--marker");

if (!inputPath) throw new Error("--input <path to target-rows.json> is required.");
if (!markerDate || !MARKER_PATTERN.test(markerDate)) {
  throw new Error(
    "--marker <YYYY-MM-DD[-suffix]> is required: the date of THIS run, stamped into every row so this batch "
      + "can be identified and reversed on its own. Do not reuse a previous run's date: the "
      + "committed constant was last left reading 2026-08-03, and a run inheriting it would fold "
      + "its rows into a batch from months earlier. If another batch already ran today, add a "
      + "suffix (2026-10-01-aug) so the two can be told apart.",
  );
}
const BATCH_MARKER = `CRM_BACKFILL_${markerDate}`;

const allRows = JSON.parse(fs.readFileSync(inputPath, "utf8")) as TargetRow[];
const rows = limit ? allRows.slice(0, limit) : allRows;

console.log(`${execute ? "EXECUTE" : "DRY RUN"} — ${rows.length} of ${allRows.length} rows`);

const outcomes: Outcome[] = [];

for (const [index, row] of rows.entries()) {
  const base = { date: row.date, hrId: row.hrId, name: row.name, workingDays: row.workingDays };
  try {
    // Guard 0 — the leave must be able to belong to this employee at all. A CRM account is a SEAT
    // that the vendor renames to its next occupant, and a re-sync stamps historical visits with the
    // CURRENT name — so an input row can carry a person who had not joined yet. CRM_BACKFILL_2026-08-24
    // did exactly that once, giving PD-0009 an approved leave dated 167 days before his hire date,
    // and nothing caught it: a pre-hire date breaks no constraint, and the balance engine refuses to
    // PAY such a day without refusing to CREATE it. See src/lib/vacation/backfill-guards.ts.
    const { data: employeeRow, error: employeeError } = await getSupabaseAdmin()
      .from("employees")
      .select("hire_date")
      .eq("hr_id", row.hrId)
      .maybeSingle();
    if (employeeError) throw new Error(`Hire-date check failed: ${employeeError.message}`);
    const hireVerdict = refuseLeaveBeforeHire({
      hireDate: (employeeRow as { hire_date: string | null } | null)?.hire_date ?? null,
      leaveDate: row.date,
      today: currentCairoDateOnlyIso(),
    });
    if (!hireVerdict.ok) {
      outcomes.push({ ...base, reason: hireVerdict.reason, status: "failed" });
      continue;
    }

    // Guard 1 — national-holiday adjacency (same check the approve route applies).
    await validateOfficialHolidayAdjacency({ endDate: row.date, startDate: row.date });

    // Guard 2 — overlap containment. Matches the uppercased hr_id convention the balance engine
    // (approvedPaidDaysInPeriod) uses, so this catches exactly the rows that would double-count.
    const { data: overlapping, error: overlapError } = await getSupabaseAdmin()
      .from("v2_vacation_requests")
      .select("id,start_date,end_date,status")
      .eq("employee_hr_id", row.hrId.toUpperCase())
      .not("status", "in", "(rejected,cancelled)")
      .lte("start_date", row.date)
      .gte("end_date", row.date)
      .limit(1);
    if (overlapError) throw new Error(`Overlap check failed: ${overlapError.message}`);
    if (overlapping && overlapping.length > 0) {
      const existing = overlapping[0] as { end_date: string; id: string; start_date: string };
      outcomes.push({
        ...base,
        reason: `Already covered by request ${existing.id} (${existing.start_date} → ${existing.end_date})`,
        status: "skipped_existing",
      });
      continue;
    }

    if (!execute) {
      outcomes.push({ ...base, status: "dry_run_ok" });
      continue;
    }

    const created = await createVacationRequestAsAdmin(systemAccessContext, {
      dayPart: row.workingDays === 1 ? "full_day" : row.dayPart,
      employeeHrId: row.hrId,
      endDate: row.date,
      notes: `[${BATCH_MARKER}] Imported from the CRM vacation signal for ${row.date}. Original CRM detail: "${row.detail}". Owner-approved backfill of CRM-recorded leave missing from Phoenix.`,
      startDate: row.date,
      status: "approved",
      vacationType: "annual",
    });
    outcomes.push({ ...base, requestId: created.id, status: "created" });
  } catch (error) {
    outcomes.push({ ...base, reason: vacationErrorMessage(error) || String(error), status: "failed" });
  }

  if ((index + 1) % 25 === 0) console.log(`  ...${index + 1}/${rows.length}`);
}

const summary = {
  created: outcomes.filter((o) => o.status === "created").length,
  daysCharged: outcomes
    .filter((o) => o.status === "created" || o.status === "dry_run_ok")
    .reduce((sum, o) => sum + Number(o.workingDays), 0),
  dryRunOk: outcomes.filter((o) => o.status === "dry_run_ok").length,
  failed: outcomes.filter((o) => o.status === "failed").length,
  skippedExisting: outcomes.filter((o) => o.status === "skipped_existing").length,
  total: outcomes.length,
};

// The result goes BESIDE the input, never over it. `replace` returns the string unchanged when the
// pattern does not match, so an input not named `target-rows.json` used to have its own contents
// overwritten by the result — measured 2026-09-30, when a 108-row reviewed list was destroyed by the
// run that read it. A suffix is appended in that case instead.
const resultName = execute ? "result-execute.json" : "result-dryrun.json";
const outPath = /target-rows\.json$/.test(inputPath)
  ? inputPath.replace(/target-rows\.json$/, resultName)
  : `${inputPath.replace(/\.json$/, "")}.${resultName}`;
fs.writeFileSync(outPath, JSON.stringify({ outcomes, summary }, null, 2));

console.log(JSON.stringify(summary, null, 2));
console.log(`Detail written to ${outPath}`);

const failureReasons = new Map<string, number>();
for (const outcome of outcomes) {
  if (outcome.status !== "failed") continue;
  const key = (outcome.reason ?? "unknown").slice(0, 120);
  failureReasons.set(key, (failureReasons.get(key) ?? 0) + 1);
}
if (failureReasons.size > 0) {
  console.log("\nFailure reasons:");
  for (const [reason, count] of [...failureReasons.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${count}x  ${reason}`);
  }
}
