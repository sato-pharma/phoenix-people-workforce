import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { systemAccessContext } from "@/lib/auth/permissions";
import { CRM_VISITS_TABLE } from "@/lib/crm/tables";
import { resolveOutstationGateState } from "@/lib/outstation/expense-gate";
import {
  retryOutstationWorkloadCapture,
  setOutstationWorkloadManually,
} from "@/lib/outstation/service";
import type {
  OutstationEvidenceGateStatus,
  OutstationWorkloadGateStatus,
} from "@/lib/outstation/types";
import { captureOutstationTripWorkload } from "@/lib/outstation/workload-capture";
import { rollupHopsForRole } from "@/lib/outstation/workload-rollup";

// ─────────────────────────────────────────────────────────────────────────────
// Diagnose — and, when the CRM genuinely cannot answer, repair — an outstation
// request stuck on its AM/PM workload gate.
//
// The gate is the third and last checkpoint before payroll (expense-gate.ts). When it sticks, the
// employee sees only that his money has not arrived, and the Super Admin repair panel is supposed
// to offer two ways out: re-run the CRM grab, or type the numbers in. Choosing between those
// blind is the mistake this script exists to prevent — a retry that cannot possibly succeed does
// not just waste an attempt, it writes AM 0 / PM 0 stamped `ireports360` / `complete`, which
// reads forever after as "the CRM measured that he did no work".
//
// So `preview` answers the only question that matters first: WOULD A RETRY FIND ANYTHING? It
// answers it by running the real capture (read-only — captureOutstationTripWorkload never writes)
// and by listing every CRM row in the trip window with its visit type, so the reason a row does
// or does not count is visible rather than inferred.
//
// The counter deliberately counts FIELD visits only — visit_type 0 (Regular) and -8 (Campaign).
// A Meeting, Conference or Training row is real work that lands in `other` and never in AM/PM.
// For a manager whose trip day was a business review rather than a field round, that is the whole
// explanation, and no retry will ever change it.
//
// Usage:
//   pnpm run outstation:workload-repair:preview                 every request held on its workload
//   pnpm run outstation:workload-repair preview --id 67         just that one
//   pnpm run outstation:workload-repair retry --ids 65,66,70 --apply
//   pnpm run outstation:workload-repair apply --id 67 --am 0 --pm 1 --reason "…" --apply
//
// `retry` re-runs the CRM grab through retryOutstationWorkloadCapture — the repair panel's own
// re-run — for each id in turn. It REFUSES any request whose capture comes back 0/0, because
// writing that is the fabricated measurement described above; those need `apply` and a human's
// number. So the futile case cannot be reached by accident even from the bulk path.
//
// `apply` goes through setOutstationWorkloadManually — the same service call the repair panel
// makes — so the numbers are stamped `manual` / `override` with a mandatory reason, an audit row
// is written, and the payroll release is attempted under its own rules. It is NOT a raw UPDATE.
// ─────────────────────────────────────────────────────────────────────────────

const PRODUCTION_REF = "ozucdzovmcqvepbozvqf";

/** The only two visit types getRepTripVisitWorkload counts into AM/PM. Everything else is `other`. */
const COUNTED_VISIT_TYPES = new Set([0, -8]);

type RequestRow = {
  am_workload: number | null;
  car_evidence_image_path: string | null;
  departure_evidence_image_path: string | null;
  employee_hr_id: string | null;
  employee_name: string | null;
  employee_role: string | null;
  evidence_gate_status: string | null;
  expected_total_amount: number | null;
  id: number;
  pm_workload: number | null;
  status: string | null;
  trip_end_date: string | null;
  trip_start_date: string | null;
  workload_capture_attempts: number | null;
  workload_gate_status: string | null;
  workload_last_attempt_error: string | null;
  workload_match_status: string | null;
  workload_matched_at: string | null;
  workload_source: string | null;
};

type VisitRow = {
  agent_crm_id: number | null;
  ampm: string | null;
  comment: string | null;
  crm_visit_id: number | null;
  double_crm_id: number | null;
  visit_date: string | null;
  visit_type: number | null;
  visit_type_description: string | null;
};

/**
 * The gate resolver takes the narrow unions; a `select("*")` hands back whatever text the column
 * actually holds. A CHECK constraint keeps production honest, so these normally pass straight
 * through — but an unrecognised value is a corrupt row, and the one thing this script must not do
 * is quietly cast it into a state that reads as satisfied. It falls back to the strictest value
 * and says so, which is also how resolveOutstationGateState itself treats a disagreement.
 */
const EVIDENCE_GATE_STATUSES: OutstationEvidenceGateStatus[] = [
  "pending_arrival_photo",
  "pending_departure_photo",
  "complete",
  "grandfathered",
];
const WORKLOAD_GATE_STATUSES: OutstationWorkloadGateStatus[] = [
  "pending_workload",
  "complete",
  "manual",
  "grandfathered",
];

function evidenceGateStatus(value: string | null): OutstationEvidenceGateStatus {
  const known = EVIDENCE_GATE_STATUSES.find((status) => status === value);
  if (!known) {
    console.warn(`    unrecognised evidence_gate_status ${JSON.stringify(value)} — read as pending_arrival_photo`);
  }
  return known ?? "pending_arrival_photo";
}

function workloadGateStatus(value: string | null): OutstationWorkloadGateStatus {
  const known = WORKLOAD_GATE_STATUSES.find((status) => status === value);
  if (!known) {
    console.warn(`    unrecognised workload_gate_status ${JSON.stringify(value)} — read as pending_workload`);
  }
  return known ?? "pending_workload";
}

function currentProjectRef(): string {
  return (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/^https:\/\//, "").split(".")[0] ?? "";
}

function client(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function flag(args: string[], name: string): string | null {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}

function day(value: string | null | undefined): string {
  return String(value ?? "").slice(0, 10);
}

/** Every date from start to end inclusive — the same window the capture measures. */
function tripDates(startIso: string, endIso: string): string[] {
  const start = day(startIso);
  const end = day(endIso) || start;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return [];
  const dates: string[] = [];
  const cursor = new Date(`${start}T00:00:00.000Z`);
  const last = new Date(`${(end >= start ? end : start)}T00:00:00.000Z`);
  for (let guard = 0; cursor <= last && guard < 400; guard += 1) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

async function crmIdFor(db: SupabaseClient, hrId: string): Promise<number | null> {
  const { data } = await db.from("employees").select("crm_id").ilike("hr_id", hrId).limit(1);
  const raw = (data ?? [])[0]?.crm_id;
  const crmId = raw == null ? null : Number(raw);
  return crmId == null || Number.isNaN(crmId) ? null : crmId;
}

async function diagnose(db: SupabaseClient, request: RequestRow) {
  const hrId = String(request.employee_hr_id ?? "");
  const role = request.employee_role ?? "";
  const start = day(request.trip_start_date);
  const end = day(request.trip_end_date) || start;
  const dates = tripDates(start, end);

  const gate = resolveOutstationGateState({
    employeeRole: role,
    evidenceGateStatus: evidenceGateStatus(request.evidence_gate_status),
    hasArrivalPhoto: Boolean(request.car_evidence_image_path),
    hasDeparturePhoto: Boolean(request.departure_evidence_image_path),
    workloadGateStatus: workloadGateStatus(request.workload_gate_status),
  });

  console.log(`\n─── request ${request.id} · ${request.employee_name ?? "?"} (${hrId}) · ${role}`);
  console.log(`    trip        ${start}${end !== start ? ` → ${end}` : ""}  (${dates.length} day(s))`);
  console.log(`    status      ${request.status}   amount EGP ${request.expected_total_amount ?? 0}`);
  console.log(`    gate        blocker=${gate.blocker ?? "none"}  payrollEligible=${gate.isPayrollEligible}`);
  console.log(`                ${gate.message}`);
  console.log(
    `    stored      AM ${request.am_workload ?? 0} / PM ${request.pm_workload ?? 0}` +
      `  gate=${request.workload_gate_status}  match=${request.workload_match_status}` +
      `  source=${request.workload_source}  attempts=${request.workload_capture_attempts ?? 0}`,
  );
  console.log(`    matched at  ${request.workload_matched_at ?? "never"}`);
  if (request.workload_last_attempt_error) {
    console.log(`    last error  ${request.workload_last_attempt_error}`);
  }

  const hops = rollupHopsForRole(role);
  console.log(`    rollup      ${hops} hop(s) for this role`);

  // Every CRM row in the window that names this person, either as the agent or as the
  // double-visit partner — the exact population getRepTripVisitWorkload reads.
  const crmId = await crmIdFor(db, hrId);
  if (crmId == null) {
    console.log(`    CRM         this employee has NO crm_id, so no visit can ever match`);
  } else {
    const { data, error } = await db
      .from(CRM_VISITS_TABLE)
      .select("agent_crm_id, ampm, comment, crm_visit_id, double_crm_id, visit_date, visit_type, visit_type_description")
      .gte("visit_date", start)
      .lte("visit_date", `${end}T23:59:59.999Z`)
      .or(`agent_crm_id.eq.${crmId},double_crm_id.eq.${crmId}`);
    if (error) throw new Error(error.message);

    const rows = (data ?? []) as VisitRow[];
    console.log(`    CRM         crm_id ${crmId} · ${rows.length} row(s) in the window`);
    for (const row of rows) {
      const counts = COUNTED_VISIT_TYPES.has(Number(row.visit_type));
      console.log(
        `                ${counts ? "COUNTS " : "ignored"} ${day(row.visit_date)}` +
          ` ${String(row.ampm ?? "?").padEnd(2)} type ${String(row.visit_type).padStart(3)}` +
          ` ${row.visit_type_description ?? "?"}` +
          `${row.double_crm_id ? ` double=${row.double_crm_id}` : ""}` +
          `${row.comment ? `  "${row.comment}"` : ""}`,
      );
    }
    if (rows.length > 0 && !rows.some((row) => COUNTED_VISIT_TYPES.has(Number(row.visit_type)))) {
      console.log(
        `                ↑ every row is a non-field type. The counter reads Regular (0) and` +
          ` Campaign (-8) only, so these are real work that AM/PM cannot see.`,
      );
    }
  }

  // The decisive answer: run the real capture. Read-only — it writes nothing.
  const capture = await captureOutstationTripWorkload({
    employeeHrId: hrId,
    employeeRole: role,
    tripEndDate: end,
    tripStartDate: start,
  });

  if (!capture.captured) {
    console.log(`    retry would FAIL: ${capture.reason}`);
    console.log(`    → a retry is worth trying only once the cause above is gone.`);
    return { capture, futile: false, request };
  }

  console.log(`    retry would compute AM ${capture.amWorkload} / PM ${capture.pmWorkload}`);
  for (const dayCount of capture.days) {
    console.log(`                ${dayCount.date}  AM ${dayCount.am} / PM ${dayCount.pm}  counted: ${dayCount.countedHrIds.join(", ")}`);
  }

  const futile = capture.amWorkload === 0 && capture.pmWorkload === 0;
  if (futile) {
    console.log(
      `    → RETRY IS FUTILE. It would still succeed, and stamp AM 0 / PM 0 as an` +
        ` iReports360 MEASUREMENT with the gate marked complete. Enter the workload by hand instead.`,
    );
  } else {
    console.log(`    → RETRY WOULD FIX THIS. Use the repair panel's re-run, not a hand-typed number.`);
  }
  return { capture, futile, request };
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  if (command !== "preview" && command !== "retry" && command !== "apply") {
    console.log(
      "\nUsage:\n" +
        "  preview [--id N]\n" +
        "  retry --ids 65,66,70 --apply\n" +
        '  apply --id N --am A --pm P --reason "why" --apply\n',
    );
    process.exit(1);
  }

  const ref = currentProjectRef();
  console.log(`Supabase project ref: ${ref}${ref === PRODUCTION_REF ? " (PRODUCTION)" : ""}`);

  const db = client();
  const idFlag = flag(args, "id");
  const wantedId = idFlag == null ? null : Number(idFlag);
  if (idFlag != null && !Number.isInteger(wantedId)) throw new Error("--id must be a whole number.");

  const idsFlag = flag(args, "ids");
  const wantedIds = idsFlag == null
    ? null
    : idsFlag.split(",").map((part) => {
        const id = Number(part.trim());
        if (!Number.isInteger(id)) throw new Error(`--ids must be whole numbers: "${part}"`);
        return id;
      });
  if (wantedIds != null && wantedId != null) throw new Error("Pass --id or --ids, not both.");

  let query = db.from("outstation_expense_requests").select("*").order("id", { ascending: true });
  if (wantedIds != null) query = query.in("id", wantedIds);
  else if (wantedId != null) query = query.eq("id", wantedId);
  else query = query.eq("workload_gate_status", "pending_workload");
  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const requests = (data ?? []) as RequestRow[];
  if (requests.length === 0) {
    console.log(
      wantedIds != null || wantedId != null
        ? "None of those request ids were found."
        : "No request is held on its workload.",
    );
    return;
  }
  // Say what was asked for but not found, rather than silently repairing a shorter list.
  if (wantedIds != null) {
    const found = new Set(requests.map((request) => request.id));
    const missing = wantedIds.filter((id) => !found.has(id));
    if (missing.length > 0) console.log(`NOT FOUND, skipped: ${missing.join(", ")}`);
  }
  console.log(`${requests.length} request(s) to diagnose.`);

  const results = [];
  for (const request of requests) results.push(await diagnose(db, request));

  if (command === "preview") {
    const futile = results.filter((result) => result.futile).map((result) => result.request.id);
    console.log(
      `\nPreview only — nothing was written.` +
        (futile.length > 0 ? `\nRetry is futile for: ${futile.join(", ")} — these need a hand-entered workload.` : ""),
    );
    return;
  }

  if (!args.includes("--apply")) throw new Error("Refusing to write without --apply.");

  if (command === "retry") {
    console.log(`\n─── re-running the CRM grab on ${results.length} request(s)`);
    for (const { capture, futile, request } of results) {
      if (futile) {
        console.log(
          `SKIP ${request.id} — the capture returns 0/0, and storing that would record a` +
            ` measurement the CRM never made. Use apply with a reason instead.`,
        );
        continue;
      }
      if (!capture.captured) {
        console.log(`SKIP ${request.id} — the capture is currently failing: ${capture.reason}`);
        continue;
      }
      const before = `AM ${request.am_workload ?? 0} / PM ${request.pm_workload ?? 0}`;
      const result = await retryOutstationWorkloadCapture(request.id, systemAccessContext);
      // Re-read rather than trust the message: retryOutstationWorkloadCapture is deliberately
      // best-effort and reports what it found, so the row is the only honest "after".
      const { data: after } = await db
        .from("outstation_expense_requests")
        .select("am_workload, pm_workload, workload_gate_status, workload_source, workload_capture_attempts")
        .eq("id", request.id)
        .maybeSingle();
      const row = (after ?? {}) as Partial<RequestRow>;
      console.log(
        `RETRIED ${request.id}: ${before} → AM ${row.am_workload ?? "?"} / PM ${row.pm_workload ?? "?"}` +
          `  gate=${row.workload_gate_status}  source=${row.workload_source}` +
          `  attempts=${row.workload_capture_attempts}`,
      );
      console.log(`           released into payroll: ${result.released} — ${result.message}`);
    }
    return;
  }

  if (wantedId == null) throw new Error("apply repairs one request at a time: pass --id N.");

  const amWorkload = Number(flag(args, "am"));
  const pmWorkload = Number(flag(args, "pm"));
  const reason = flag(args, "reason") ?? "";
  // Left to setOutstationWorkloadManually to validate properly (whole, non-negative, reason
  // present) — re-implementing those rules here is how the two copies drift apart.
  const result = await setOutstationWorkloadManually(wantedId, systemAccessContext, {
    amWorkload,
    pmWorkload,
    reason,
  });
  console.log(`\nAPPLIED to request ${wantedId}: AM ${amWorkload} / PM ${pmWorkload}`);
  console.log(`  ${result.message}`);
  console.log(`  released into payroll: ${result.released}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
