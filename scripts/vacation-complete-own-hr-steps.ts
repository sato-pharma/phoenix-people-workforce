/**
 * Close the requests that were already waiting on their own sender's HR acknowledgement when the rule
 * "the HR approver's own leave is approved once management approves it" landed (owner, 27 Nov 2026).
 *
 * Lists every request at "pending_hr" whose pending HR step is assigned to the requester himself, and
 * with --apply completes each one through completeOwnHrStep — the same decision path the HR approver's
 * own click runs. Without --apply it only lists. It writes the database .env.local names (PRODUCTION).
 *
 *   node --experimental-strip-types --experimental-specifier-resolution=node \
 *     --import ./tests/register-alias-loader.mjs --env-file=.env.local \
 *     scripts/vacation-complete-own-hr-steps.ts [--apply]
 */
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { completeOwnHrStep } from "@/lib/vacation/service";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "vacation-complete-own-hr-steps",
  entry: import.meta.url,
  known: ["--apply"],
});

const apply = process.argv.includes("--apply");
const key = (value: unknown) => String(value ?? "").trim().toUpperCase();

const { data: requests, error } = await getSupabaseAdmin()
  .from("v2_vacation_requests")
  .select("id, request_code, employee_hr_id, start_date, end_date, vacation_type")
  .eq("status", "pending_hr")
  .order("start_date");
if (error) throw error;

const ids = (requests ?? []).map((row) => row.id);
const { data: steps, error: stepsError } = ids.length
  ? await getSupabaseAdmin()
      .from("v2_vacation_approval_steps")
      .select("request_id, step_key, approver_hr_id, status")
      .in("request_id", ids)
      .eq("step_key", "hr")
      .eq("status", "pending")
  : { data: [], error: null };
if (stepsError) throw stepsError;

const own = (requests ?? []).filter((row) =>
  (steps ?? []).some((step) => step.request_id === row.id && key(step.approver_hr_id) === key(row.employee_hr_id)),
);
console.log(`${own.length} request(s) waiting on their own sender's HR step${apply ? "" : " (list only; --apply to complete)"}`);
for (const row of own) {
  const label = `${row.request_code} · ${row.employee_hr_id} · ${row.vacation_type} · ${row.start_date} → ${row.end_date}`;
  if (!apply) {
    console.log(`  ${label}`);
    continue;
  }
  const approved = await completeOwnHrStep(row.id);
  console.log(`  ${label} → ${approved ? `${approved.status} (${approved.paymentStatus ?? "no payment status"})` : "NOT completed: the rule did not apply"}`);
}
process.exit(0);
