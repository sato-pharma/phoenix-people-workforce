import type { AccessContext } from "@/lib/auth/permissions";
import { forbiddenError } from "@/lib/http/api-errors";
import { canonicalHrIdKey, hrIdLookupKeys } from "@/lib/hr-id";
import {
  buildFinanceAgeingRows,
  canViewMarketingFinanceAgeing,
  summarizeFinanceAgeing,
  type FinanceAgeingRequestInput,
  type FinanceAgeingStepInput,
  type MarketingFinanceAgeing,
} from "@/lib/marketing-requests/finance-ageing";
import { EXECUTION_STEP_CODE } from "@/lib/marketing-requests/request-status-label";
import { marketingRequestActivity } from "@/lib/marketing-requests/request-title";
import {
  loadMarketingStepOpenedAt,
  marketingDaysWaiting,
  marketingStepKey,
  marketingWaitingSince,
} from "@/lib/marketing-requests/service";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// Same guard as the module's other bulk reads: PostgREST folds every .in() value into the URL.
function chunk<T>(items: readonly T[], size = 100): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

function distinct<T>(items: readonly T[]): T[] {
  return Array.from(new Set(items));
}

async function readByIn<T>(
  ids: ReadonlyArray<string | number>,
  read: (batch: Array<string | number>) => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (const batch of chunk(ids)) {
    const { data, error } = await read(batch);
    if (error) throw error;
    rows.push(...((data ?? []) as T[]));
  }
  return rows;
}

function cleanText(value: string | null | undefined): string | null {
  return String(value ?? "").replace(/\s+/g, " ").trim() || null;
}

/**
 * Every approved request waiting at Finance Execution, oldest first.
 *
 * The gate is here as well as on the page and the export, before a single row is read. A failed read
 * THROWS rather than degrading: on a report of what is unpaid, a missing part would read as nothing
 * owed. Names come from the employees table directly, because the employee directory drops the
 * accounts it hides from the organogram and would show those requesters as a bare HR id.
 */
export async function getMarketingFinanceAgeing(access: AccessContext): Promise<MarketingFinanceAgeing> {
  if (!canViewMarketingFinanceAgeing(access.role)) {
    throw forbiddenError("You do not have access to Finance Ageing.");
  }

  const supabase = getSupabaseAdmin();
  const generatedAtIso = new Date().toISOString();

  const stepResult = await supabase
    .from("marketing_request_approval_steps")
    .select("request_id, step_code, sequence, status, is_cc, created_at, updated_at")
    .eq("status", "current")
    .eq("is_cc", false)
    .eq("step_code", EXECUTION_STEP_CODE);
  if (stepResult.error) throw stepResult.error;
  const stepRows = (stepResult.data ?? []) as Array<{
    created_at: string | null;
    is_cc: boolean;
    request_id: string;
    sequence: number | string;
    status: string;
    step_code: string;
    updated_at: string | null;
  }>;
  if (stepRows.length === 0) {
    return { generatedAtIso, rows: [], totals: summarizeFinanceAgeing([]) };
  }

  const requestIds = distinct(stepRows.map((row) => row.request_id));
  const [openedAt, requestRows] = await Promise.all([
    loadMarketingStepOpenedAt(supabase, requestIds),
    readByIn<{
      customer_id: string;
      estimated_cost: number | string | null;
      id: string;
      line: { name: string | null } | null;
      line_id: number | string | null;
      other_request_type: string | null;
      pay_date: string | null;
      request_code: string;
      request_type_id: number | string;
      requester_hr_id: string | null;
      status: string;
    }>(requestIds, (batch) =>
      supabase
        .from("marketing_requests")
        .select("id, request_code, status, customer_id, request_type_id, other_request_type, requester_hr_id, line_id, line:lines(name), estimated_cost, pay_date")
        .in("id", batch)
        .eq("status", "pending_approval"),
    ),
  ]);

  const requesterKeys = distinct(requestRows.flatMap((row) => hrIdLookupKeys(row.requester_hr_id)));
  const [customers, types, employees] = await Promise.all([
    readByIn<{ display_name: string | null; id: string }>(distinct(requestRows.map((row) => row.customer_id)), (batch) =>
      supabase.from("marketing_customers").select("id, display_name").in("id", batch),
    ),
    readByIn<{ id: number | string; name: string | null }>(distinct(requestRows.map((row) => row.request_type_id)), (batch) =>
      supabase.from("marketing_request_types").select("id, name").in("id", batch),
    ),
    readByIn<{ full_name: string | null; hr_id: string }>(requesterKeys, (batch) =>
      supabase.from("employees").select("hr_id, full_name").in("hr_id", batch),
    ),
  ]);

  const customerName = new Map(customers.map((row) => [row.id, cleanText(row.display_name)] as const));
  const typeName = new Map(types.map((row) => [String(row.id), row.name] as const));
  const requesterName = new Map(employees.map((row) => [canonicalHrIdKey(row.hr_id), cleanText(row.full_name)] as const));

  const requestsById = new Map<string, FinanceAgeingRequestInput>(
    requestRows.map((row) => [
      row.id,
      {
        customerName: customerName.get(row.customer_id) ?? "Customer not on file",
        estimatedCost: Number(row.estimated_cost ?? 0),
        id: row.id,
        lineName: cleanText(row.line?.name) || "No line",
        payDate: row.pay_date,
        requestCode: row.request_code,
        requesterName: requesterName.get(canonicalHrIdKey(row.requester_hr_id)) ?? "Name not on file",
        requestType: marketingRequestActivity(typeName.get(String(row.request_type_id)), row.other_request_type),
        status: row.status,
      },
    ]),
  );

  const steps: FinanceAgeingStepInput[] = stepRows.map((row) => ({
    createdAt: row.created_at,
    isCc: row.is_cc,
    openedAt: openedAt.get(marketingStepKey(row.request_id, Number(row.sequence))) ?? null,
    requestId: row.request_id,
    status: row.status,
    stepCode: row.step_code,
    updatedAt: row.updated_at,
  }));

  const rows = buildFinanceAgeingRows({
    clock: { daysWaiting: marketingDaysWaiting, waitingSince: marketingWaitingSince },
    now: generatedAtIso,
    requestsById,
    steps,
  });
  return { generatedAtIso, rows, totals: summarizeFinanceAgeing(rows) };
}
