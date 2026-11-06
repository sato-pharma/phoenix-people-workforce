#!/usr/bin/env node
// DRY RUN ONLY — reports what the unpaid-vacation connector WOULD create for a
// month, and writes nothing.
//
// Safe by construction, not by promise: `collectUnpaidVacationCandidates`
// returns drafts and performs no insert. The insert lives in
// `collectOneConnectorForMonth` (service.insertCandidateDrafts), which this
// script never calls. Everything below is SELECT-only.
//
// WHAT IT IS PROVING.
//
// The HR-request path used to re-charge a day a `crm_vacation_signal` candidate
// already claimed, because the two sources key their candidates differently and
// nothing in the insert path compares DAYS. Re-running 2026-07 on 2026-08-03
// created 23 candidates where 7 were due, and 13 duplicate employee-days.
//
// So the headline number is COLLISIONS: employee-days a NEW candidate would
// claim that the live ledger already charges. It must be ZERO.
//
//   node --env-file-if-exists=.env.local --experimental-strip-types \
//     --experimental-specifier-resolution=node \
//     --experimental-loader ./tests/alias-loader.mjs \
//     scripts/dry-run-vacation-ledger-guard.ts 2026-07

import { fetchAllRows } from "../src/lib/supabase/paginated.ts";
import { getSupabaseAdmin } from "../src/lib/supabase/server.ts";
import { buildDeductionsCandidateKey, compactDeductionsHrId } from "../src/lib/deductions/candidate-key.ts";
import { clipLeaveToMonth, collectUnpaidVacationCandidates } from "../src/lib/deductions/connectors/vacation.ts";

type LiveRow = {
  candidate_key: string;
  category: string;
  source_system: string;
  employee_hr_id_compact: string;
  employee_name: string | null;
  dates: unknown;
};

function money(value: number | null | undefined): string {
  if (value == null) return "requires review";
  return new Intl.NumberFormat("en", { maximumFractionDigits: 2, minimumFractionDigits: 2 }).format(value);
}

async function main() {
  const monthKey = process.argv[2] ?? "";
  if (!/^\d{4}-\d{2}$/.test(monthKey)) {
    console.error("Usage: dry-run-vacation-ledger-guard <YYYY-MM>");
    process.exit(2);
  }
  const [year, month] = monthKey.split("-").map(Number);

  console.log(`\n=== DRY RUN — unpaid-vacation connector, ${monthKey} ===`);
  console.log("SELECT-only. Nothing is written to deductions_candidates.\n");

  // Print and verify the exact target before touching the database. The project
  // ref is the hostname label of the public URL — never a key. `.env.local` on
  // this machine points at PRODUCTION, so this must be stated, not assumed.
  const projectRef = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://unset").hostname.split(".")[0] ?? "";
  const KNOWN: Record<string, string> = {
    ozucdzovmcqvepbozvqf: "PRODUCTION (Phoenix HR)",
    cifwmndunmlxjhyjugxa: "staging (Phoenix-HR-Staging)",
  };
  const label = KNOWN[projectRef];
  console.log(`Supabase project ref: ${projectRef} — ${label ?? "UNRECOGNISED"}`);
  if (!label) {
    console.error("\nRefusing to run against an unrecognised project ref. Resolve it with list_projects first.\n");
    process.exit(3);
  }

  // ── 1. The live ledger as it stands right now ────────────────────────────
  // Paged: one read stops silently at 1,000 rows, and a ledger day missed here would hide a collision.
  const supabase = getSupabaseAdmin();
  const live = await fetchAllRows<LiveRow>(
    () =>
      supabase
        .from("deductions_candidates")
        .select("candidate_key, category, source_system, employee_hr_id_compact, employee_name, dates")
        .eq("month_key", monthKey)
        .is("superseded_at", null),
    "id",
  ).catch((error: { message?: string }) => {
    throw new Error(`Failed to read the live ledger: ${error.message ?? String(error)}`);
  });

  const claimedDays = new Map<string, LiveRow>();
  const liveKeys = new Set<string>();
  const bySource = new Map<string, number>();
  for (const row of live) {
    liveKeys.add(`${row.category} ${row.candidate_key}`);
    bySource.set(row.source_system, (bySource.get(row.source_system) ?? 0) + 1);
    if (!Array.isArray(row.dates)) continue;
    for (const date of row.dates as unknown[]) {
      if (typeof date === "string" && date.trim()) claimedDays.set(`${row.employee_hr_id_compact}:${date.trim()}`, row);
    }
  }

  console.log(`Live candidates in ${monthKey}: ${live.length}`);
  console.log(`Live employee-days claimed:    ${claimedDays.size}`);
  for (const [source, count] of [...bySource].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${source.padEnd(28)} ${String(count).padStart(5)}`);
  }

  // ── 2. What the connector would produce now ──────────────────────────────
  const drafts = await collectUnpaidVacationCandidates({ month: month!, year: year! });
  const fromRequests = drafts.filter((draft) => draft.sourceSystem === "vacation_balance");
  const fromCrm = drafts.filter((draft) => draft.sourceSystem === "crm_vacation_signal");
  console.log(`\nDrafts returned: ${drafts.length}  (HR request ${fromRequests.length}, CRM signal ${fromCrm.length})`);

  // ── 3. Which drafts would actually be INSERTED (key not already live) ────
  //
  // This split has to come FIRST. A draft whose key is already live is the SAME
  // row regenerated — insertCandidateDrafts skips it by key, so it can never
  // duplicate anything and must not be counted as colliding with its own
  // existing row. Counting those was this script's own first false alarm.
  const insertable: typeof drafts = [];
  let skippedByKey = 0;
  let total = 0;
  for (const draft of drafts) {
    const key = buildDeductionsCandidateKey({
      sourceSystem: draft.sourceSystem,
      sourceRecordId: draft.sourceRecordId,
      employeeHrId: draft.employeeHrId,
      monthKey: draft.monthKey,
      category: draft.category,
      dates: draft.dates ?? [],
    });
    if (liveKeys.has(`${draft.category} ${key}`)) skippedByKey += 1;
    else {
      insertable.push(draft);
      total += draft.estimatedAmount ?? 0;
    }
  }

  console.log(`\nWould INSERT ${insertable.length} new candidate(s), ${money(total)} EGP`);
  console.log(`Already live by key, skipped:  ${skippedByKey}`);
  for (const draft of insertable) {
    console.log(
      `  NEW  ${(draft.employeeName ?? draft.employeeHrId).padEnd(40)} ${draft.sourceSystem.padEnd(20)} ` +
        `${String(draft.rawValue).padStart(5)} day(s) ${money(draft.estimatedAmount).padStart(10)} EGP  [${(draft.dates ?? []).join(", ")}]`,
    );
  }

  // ── 4. THE HEADLINE — days a NEW draft claims that the ledger already has ─
  const collisions: Array<{ name: string; date: string; against: string }> = [];
  for (const draft of insertable) {
    const compact = compactDeductionsHrId(draft.employeeHrId) ?? "";
    for (const date of draft.dates ?? []) {
      const existing = claimedDays.get(`${compact}:${date}`);
      if (existing) {
        collisions.push({
          name: draft.employeeName ?? existing.employee_name ?? draft.employeeHrId,
          date,
          against: `${existing.source_system}/${existing.category}`,
        });
      }
    }
  }

  // ── 5. What the guard suppressed — the duplicates actually prevented ─────
  //
  // A request whose days are ALL already claimed never reaches `drafts`, so the
  // draft's own evidence cannot report it and "dropped: 0" would be
  // unmeasurable. Re-derive the pre-guard day set from the same query the
  // connector runs, through the connector's OWN exported clip helper and the
  // shared hr-id normaliser — so hr-id handling and a null end_date behave
  // identically here, and this reporting cannot drift from the code it checks.
  const requestData = await fetchAllRows<Record<string, string | number | null>>(
    () =>
      supabase
        .from("v2_vacation_requests")
        .select("id,employee_hr_id,employee_name,start_date,end_date,unpaid_duration_days,unpaid_reason")
        .eq("status", "approved")
        .gt("unpaid_duration_days", 0)
        .in("unpaid_reason", ["first_six_months", "missing_hire_date"])
        .lte("start_date", `${monthKey}-31`)
        .gte("end_date", `${monthKey}-01`),
    "id",
  ).catch((error: { message?: string }) => {
    throw new Error(`Failed to read vacation requests: ${error.message ?? String(error)}`);
  });

  let preGuardDays = 0;
  const prevented: Array<{ name: string; days: string[]; against: string[] }> = [];
  for (const row of requestData) {
    const compact = compactDeductionsHrId(String(row.employee_hr_id ?? ""));
    if (!compact) continue;
    const startDate = String(row.start_date ?? "").slice(0, 10);
    if (!startDate) continue;
    const endDate = String(row.end_date ?? row.start_date ?? "").slice(0, 10);
    const clipped = clipLeaveToMonth({
      startDate,
      endDate,
      monthKey,
      totalUnpaidDays: Number(row.unpaid_duration_days ?? 0),
    });
    preGuardDays += clipped.datesInMonth.length;
    const hit = clipped.datesInMonth.filter((date) => claimedDays.has(`${compact}:${date}`));
    if (hit.length > 0) {
      prevented.push({
        name: String(row.employee_name ?? row.employee_hr_id ?? ""),
        days: hit,
        against: [...new Set(hit.map((date) => claimedDays.get(`${compact}:${date}`)!.source_system))],
      });
    }
  }
  const preventedDays = prevented.reduce((sum, entry) => sum + entry.days.length, 0);

  console.log(`\nHR-request employee-days in ${monthKey}: ${preGuardDays} before the guard`);
  console.log(`Days the guard drops (duplicates PREVENTED): ${preventedDays} across ${prevented.length} request(s)`);
  for (const entry of prevented.slice(0, 40)) {
    console.log(`  prevented ${entry.name.padEnd(40)} ${entry.days.join(", ")}  (held by ${entry.against.join(", ")})`);
  }
  if (prevented.length > 40) console.log(`  ...and ${prevented.length - 40} more`);

  console.log(`\nDuplicate employee-days that would be created: ${collisions.length}`);
  for (const collision of collisions.slice(0, 40)) {
    console.log(`  DUPLICATE  ${collision.name.padEnd(40)} ${collision.date}  already charged by ${collision.against}`);
  }
  if (collisions.length > 40) console.log(`  ...and ${collisions.length - 40} more`);

  console.log(
    collisions.length === 0
      ? "\nRESULT: PASS — no employee-day would be charged twice."
      : `\nRESULT: FAIL — ${collisions.length} employee-day(s) would be charged twice. Do NOT run the collection.`,
  );
  console.log("\n=== DRY RUN COMPLETE — nothing written ===\n");
}

main().catch((error) => {
  console.error("dry run threw:", error);
  process.exit(1);
});
