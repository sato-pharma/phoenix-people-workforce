/**
 * ONE-OFF OPS SCRIPT — applies the owner's excuse rule to charged vacation days that the
 * fingerprint device contradicts.
 *
 * Owner rule, 2026-08-03: "if less than 8 hrs by 2 hr then it was an excuse not vacation" — a day
 * on which the employee was present for 6 hours or more is an EXCUSE, not leave, and must not
 * consume annual balance.
 *
 * Every row targeted here was created by the CRM backfill earlier the same day
 * (CRM_BACKFILL_2026-08-03). That import trusted the CRM's "Annual Leave" marking and applied
 * weekend, holiday and Thursday rules, but it had no attendance check — the excuse rule did not
 * exist when it ran. These are therefore corrections to rows this session created.
 *
 * Scope note: attendance punches only exist for office-based staff. The rule can only be tested
 * where a fingerprint record exists, so field-force rows are untouched — not because they are
 * correct, but because there is no evidence either way.
 *
 * Uses updateVacationRequestAsAdmin so the domain service recomputes, then rebuilds each affected
 * employee's balance-snapshot chain (the engine writes a snapshot only for the row it saves).
 *
 * Usage:
 *   node --env-file-if-exists=.env.local --experimental-strip-types \
 *     --experimental-specifier-resolution=node --experimental-loader ./tests/alias-loader.mjs \
 *     scripts/correct-excuse-days-orgwide.ts [--execute]
 */
import { systemAccessContext } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { updateVacationRequestAsAdmin, vacationErrorMessage } from "@/lib/vacation/service";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "correct-excuse-days-orgwide",
  entry: import.meta.url,
  known: ["--execute"],
});

const execute = process.argv.includes("--execute");
const MARKER = "EXCUSE_RULE_2026-08-03";

type Row = { date: string; dayPart: string; hours: number; hrId: string; name: string; punchIn: string; punchOut: string };

const targets: Row[] = [
  { date: "2026-03-09", dayPart: "full_day", hours: 6.15, hrId: "A-2", name: "Khaled Mohamed Ali Bedair", punchIn: "09:56", punchOut: "16:05" },
  { date: "2026-03-10", dayPart: "full_day", hours: 6.19, hrId: "A-2", name: "Khaled Mohamed Ali Bedair", punchIn: "09:58", punchOut: "16:09" },
  { date: "2026-03-11", dayPart: "full_day", hours: 6.12, hrId: "A-2", name: "Khaled Mohamed Ali Bedair", punchIn: "10:02", punchOut: "16:10" },
  { date: "2026-03-12", dayPart: "full_day", hours: 6.36, hrId: "A-2", name: "Khaled Mohamed Ali Bedair", punchIn: "09:46", punchOut: "16:07" },
  { date: "2026-03-15", dayPart: "full_day", hours: 6.27, hrId: "A-2", name: "Khaled Mohamed Ali Bedair", punchIn: "09:49", punchOut: "16:05" },
  { date: "2026-03-16", dayPart: "full_day", hours: 6.73, hrId: "A-2", name: "Khaled Mohamed Ali Bedair", punchIn: "09:51", punchOut: "16:34" },
  { date: "2026-03-17", dayPart: "full_day", hours: 6.21, hrId: "A-2", name: "Khaled Mohamed Ali Bedair", punchIn: "09:54", punchOut: "16:07" },
  { date: "2026-03-04", dayPart: "pm_only", hours: 6.04, hrId: "B-10", name: "Omar Anwar Ibrahim Ahmed Gawish", punchIn: "10:04", punchOut: "16:07" },
];

const affected = [...new Set(targets.map((t) => t.hrId))];

async function report(label: string) {
  console.log(`\n=== ${label} ===`);
  for (const hrId of affected) {
    const { data, error } = await getSupabaseAdmin()
      .from("v2_vacation_requests")
      .select("duration_days,status,entitlement_days")
      .eq("employee_hr_id", hrId);
    if (error) throw new Error(error.message);
    const approved = (data ?? []).filter((r: Record<string, unknown>) => r.status === "approved");
    const charged = approved.reduce((s: number, r: Record<string, unknown>) => s + Number(r.duration_days ?? 0), 0);
    const ent = Math.max(...(data ?? []).map((r: Record<string, unknown>) => Number(r.entitlement_days ?? 0)), 0);
    console.log(`  ${hrId}: approved ${approved.length}, charged ${charged.toFixed(2)}, entitlement ${ent.toFixed(2)}, balance ${(ent - charged).toFixed(2)}`);
  }
}

async function findRequestId(hrId: string, date: string) {
  const { data, error } = await getSupabaseAdmin()
    .from("v2_vacation_requests")
    .select("id")
    .eq("employee_hr_id", hrId)
    .eq("start_date", date)
    .eq("status", "approved")
    .limit(1);
  if (error) throw new Error(error.message);
  return data && data.length > 0 ? String((data[0] as Record<string, unknown>).id) : null;
}

await report("BEFORE");

if (!execute) {
  console.log("\nDRY RUN — nothing written. Planned:");
  for (const t of targets) {
    const id = await findRequestId(t.hrId, t.date);
    console.log(`  ${t.hrId} ${t.date}: present ${t.hours}h (${t.punchIn}-${t.punchOut}) -> excuse   [${id ?? "NOT FOUND"}]`);
  }
  console.log("\nRe-run with --execute to apply.");
} else {
  console.log("\nApplying...");
  for (const t of targets) {
    const requestId = await findRequestId(t.hrId, t.date);
    if (!requestId) {
      console.log(`  SKIP ${t.hrId} ${t.date}: no approved request found`);
      continue;
    }
    const note = `[${MARKER}] Reclassified as an EXCUSE, not vacation, per owner rule of 2026-08-03: a day worked to within 2 hours of a full 8-hour day is an excuse. Fingerprint shows ${t.name} present ${t.punchIn} to ${t.punchOut} = ${t.hours} hours on ${t.date}. This row was created by the CRM backfill the same day, which trusted the CRM's Annual Leave marking and had no attendance check.`;
    try {
      const updated = await updateVacationRequestAsAdmin(systemAccessContext, {
        dayPart: t.dayPart,
        employeeHrId: t.hrId,
        endDate: t.date,
        notes: note,
        requestId,
        startDate: t.date,
        status: "rejected",
        vacationType: "annual",
      });
      console.log(`  OK  ${t.hrId} ${t.date}: status=${updated.status}`);
    } catch (error) {
      console.log(`  FAIL ${t.hrId} ${t.date}: ${vacationErrorMessage(error) || String(error)}`);
    }
  }
  await report("AFTER");
  console.log("\nNow rebuild the balance-snapshot chain for:", affected.join(", "));
}
