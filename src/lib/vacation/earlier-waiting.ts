import { logWarning } from "@/lib/observability/log";
import { ownAndEarlierRecordHrIds } from "@/lib/employees/continuous-service";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * 🔒 APPROVE THE EARLIER REQUEST FIRST — A WARNING, NEVER A BLOCK (owner, 2026-11-17, from the Ragaa
 * audit: "Warn the approver").
 *
 * A request is priced when it is approved, against the paid days already APPROVED in its balance
 * pool (calculatePaymentForRequest → approvedPaidDaysInPeriod). So the approval ORDER decides which
 * request gets the paid days: approving a later request first lets it take the balance, and the
 * earlier one, approved afterwards, comes out unpaid. Ragaa's VAC-0729 (November) was approved 22
 * seconds before VAC-0647 (October) and took the whole sick allowance.
 *
 * The owner chose a warning: the approver of a request is told when the same person has an EARLIER
 * request in the same balance pool still waiting, and is asked to approve that one first. Nothing is
 * refused and no amount is recalculated — the decision and the money stay exactly where they were.
 *
 * Same pools as approvedPaidDaysInPeriod: annual and emergency share one balance, sick and other each
 * stand alone, and a compensatory day draws on no balance at all, so it is never warned about.
 */

const vacationRequestsTable = "v2_vacation_requests";

/** Filed and live but not decided — the same three as service.ts's IN_FLIGHT_VACATION_STATUSES. */
const WAITING_STATUSES = ["needs_assignment", "pending_manager", "pending_hr"] as const;

export type EarlierWaitingRequest = {
  endDate: string;
  id: string;
  requestCode: string | null;
  startDate: string;
  status: string;
  vacationType: string;
};

/** The balance a type draws on, or null when it draws on none (compensatory). */
export function vacationBalancePool(vacationType: string): string | null {
  if (vacationType === "annual" || vacationType === "emergency") return "annual";
  if (vacationType === "compensatory") return null;
  return vacationType || null;
}

function typesInPool(pool: string): string[] {
  return pool === "annual" ? ["annual", "emergency"] : [pool];
}

/**
 * The earliest-starting request of the same person, in the same pool, still waiting, that starts
 * BEFORE this one. Null when there is none, or when this request is itself not waiting (an approved
 * or returned request has nothing left to decide).
 */
export function findEarlierWaitingRequest(input: {
  others: EarlierWaitingRequest[];
  request: { id: string; startDate: string; status: string; vacationType: string };
}): EarlierWaitingRequest | null {
  const waiting = new Set<string>(WAITING_STATUSES);
  if (!waiting.has(input.request.status)) return null;
  const pool = vacationBalancePool(input.request.vacationType);
  if (!pool) return null;
  let earliest: EarlierWaitingRequest | null = null;
  for (const other of input.others) {
    if (other.id === input.request.id) continue;
    if (!waiting.has(other.status)) continue;
    if (vacationBalancePool(other.vacationType) !== pool) continue;
    if (!(other.startDate < input.request.startDate)) continue;
    if (!earliest || other.startDate < earliest.startDate) earliest = other;
  }
  return earliest;
}

export function earlierWaitingMessage(row: EarlierWaitingRequest): string {
  const code = row.requestCode ? `${row.requestCode} ` : "";
  return `This person has an earlier request ${code}(${row.startDate} to ${row.endDate}) still waiting. Approve that one first: the request approved first takes the paid balance, so approving this one now can leave the earlier one unpaid.`;
}

/**
 * The read behind the warning on a single request's decision screen. A warning is advice, so a failed
 * read is logged and shows nothing — it never stops the page that decides the request.
 */
export async function loadEarlierWaitingRequest(request: {
  employeeHrId: string;
  id: string;
  startDate: string;
  status: string;
  vacationType: string;
}): Promise<EarlierWaitingRequest | null> {
  try {
    return await readEarlierWaitingRequest(request);
  } catch (error) {
    logWarning("Earlier waiting leave request lookup failed", {
      context: { message: error instanceof Error ? error.message : String(error) },
      labels: { event: "vacation_earlier_waiting_lookup_failed", requestId: request.id },
    });
    return null;
  }
}

async function readEarlierWaitingRequest(request: {
  employeeHrId: string;
  id: string;
  startDate: string;
  status: string;
  vacationType: string;
}): Promise<EarlierWaitingRequest | null> {
  const pool = vacationBalancePool(request.vacationType);
  if (!pool || !(WAITING_STATUSES as readonly string[]).includes(request.status)) return null;
  const hrId = request.employeeHrId.trim().toUpperCase();
  if (!hrId) return null;
  const ownAndEarlier = ownAndEarlierRecordHrIds(hrId);
  const base = getSupabaseAdmin()
    .from(vacationRequestsTable)
    .select("id,request_code,start_date,end_date,status,vacation_type");
  const { data, error } = await (ownAndEarlier.length > 1 ? base.in("employee_hr_id", ownAndEarlier) : base.eq("employee_hr_id", hrId))
    .in("status", WAITING_STATUSES as unknown as string[])
    .in("vacation_type", typesInPool(pool))
    .lt("start_date", request.startDate);
  if (error) throw new Error(typeof error.message === "string" ? error.message : "read failed");
  return findEarlierWaitingRequest({
    others: (data ?? []).map((row) => {
      const record = row as Record<string, unknown>;
      return {
        endDate: String(record.end_date ?? ""),
        id: String(record.id ?? ""),
        requestCode: record.request_code ? String(record.request_code) : null,
        startDate: String(record.start_date ?? ""),
        status: String(record.status ?? ""),
        vacationType: String(record.vacation_type ?? ""),
      };
    }),
    request,
  });
}
