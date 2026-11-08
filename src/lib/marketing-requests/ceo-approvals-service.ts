import type { AccessContext } from "@/lib/auth/permissions";
import { todayInCairo } from "@/lib/date-only";
import { namesByHrId } from "@/lib/employees/names-by-hr-id";
import { forbiddenError } from "@/lib/http/api-errors";
import { canonicalHrIdKey, hrIdLookupKeys } from "@/lib/hr-id";
import {
  buildCeoApprovalRows,
  canViewMarketingCeoApprovals,
  CEO_APPROVAL_STEP_CODE,
  ceoApprovalsWindow,
  type CeoApprovalRequestInput,
  type CeoApprovalsRange,
  type CeoApprovalStepInput,
  type MarketingCeoApprovals,
} from "@/lib/marketing-requests/ceo-approvals";
import { marketingRequestNotificationUrl } from "@/lib/marketing-requests/notification-link";
import { marketingRequestActivity } from "@/lib/marketing-requests/request-title";
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

type StepRow = {
  decision_at: string | null;
  decision_by_hr_id: string | null;
  executed_at: string | null;
  is_cc: boolean | null;
  request_id: string;
  sequence: number | string;
  status: string;
  step_code: string;
  step_name: string | null;
};

const STEP_COLUMNS = "request_id, sequence, step_code, step_name, status, is_cc, decision_by_hr_id, decision_at, executed_at";

function toStep(row: StepRow): CeoApprovalStepInput {
  return {
    decisionAt: row.decision_at,
    decisionByHrId: row.decision_by_hr_id,
    executedAt: row.executed_at,
    isCc: Boolean(row.is_cc),
    requestId: row.request_id,
    sequence: Number(row.sequence),
    status: row.status,
    stepCode: row.step_code,
    stepName: row.step_name,
  };
}

/**
 * Every marketing request whose CEO rung was approved between two Cairo dates, with where its money
 * stands now. The gate is here as well as on the page, before a single row is read. A failed read
 * THROWS rather than degrading: a missing part would read as nothing approved.
 */
export async function getMarketingCeoApprovals(access: AccessContext, range: CeoApprovalsRange): Promise<MarketingCeoApprovals> {
  if (!canViewMarketingCeoApprovals(access.role)) {
    throw forbiddenError("You do not have access to CEO Approvals.");
  }

  const supabase = getSupabaseAdmin();
  const generatedAtIso = new Date().toISOString();
  const window = ceoApprovalsWindow(range);

  const approvalResult = await supabase
    .from("marketing_request_approval_steps")
    .select(STEP_COLUMNS)
    .eq("step_code", CEO_APPROVAL_STEP_CODE)
    .eq("status", "approved")
    .gte("decision_at", window.startIso)
    .lt("decision_at", window.endIso);
  if (approvalResult.error) throw approvalResult.error;
  const ceoApprovals = ((approvalResult.data ?? []) as StepRow[]).map(toStep);
  if (ceoApprovals.length === 0) return { generatedAtIso, range, rows: [] };

  const requestIds = distinct(ceoApprovals.map((step) => step.requestId));
  const [requestRows, stepRows] = await Promise.all([
    readByIn<{
      customer_id: string | null;
      estimated_cost: number | string | null;
      id: string;
      line: { name: string | null } | null;
      other_request_type: string | null;
      pay_date: string | null;
      request_code: string;
      request_type_id: number | string | null;
      requester_hr_id: string | null;
      status: string;
    }>(requestIds, (batch) =>
      supabase
        .from("marketing_requests")
        .select("id, request_code, status, customer_id, request_type_id, other_request_type, requester_hr_id, line:lines(name), estimated_cost, pay_date")
        .in("id", batch),
    ),
    readByIn<StepRow>(requestIds, (batch) => supabase.from("marketing_request_approval_steps").select(STEP_COLUMNS).in("request_id", batch)),
  ]);
  const steps = stepRows.map(toStep);

  const deciderIds = distinct(steps.map((step) => step.decisionByHrId).filter((id): id is string => Boolean(id)));
  const [customers, types, names, deciderTitles] = await Promise.all([
    readByIn<{ display_name: string | null; id: string }>(
      distinct(requestRows.map((row) => row.customer_id).filter((id): id is string => Boolean(id))),
      (batch) => supabase.from("marketing_customers").select("id, display_name").in("id", batch),
    ),
    readByIn<{ id: number | string; name: string | null }>(
      distinct(requestRows.map((row) => row.request_type_id).filter((id): id is number | string => id !== null)),
      (batch) => supabase.from("marketing_request_types").select("id, name").in("id", batch),
    ),
    namesByHrId([...requestRows.map((row) => row.requester_hr_id), ...deciderIds]),
    readByIn<{ hr_id: string; job_title: string | null }>(distinct(deciderIds.flatMap((id) => hrIdLookupKeys(id))), (batch) =>
      supabase.from("employees").select("hr_id, job_title").in("hr_id", batch),
    ),
  ]);

  const customerName = new Map(customers.map((row) => [row.id, cleanText(row.display_name)] as const));
  const typeName = new Map(types.map((row) => [String(row.id), row.name] as const));
  const ceoKeys = new Set(
    deciderTitles.filter((row) => cleanText(row.job_title)?.toUpperCase() === "CEO").map((row) => canonicalHrIdKey(row.hr_id)),
  );
  const deciders = new Map<string, { isCeo: boolean; name: string }>();
  for (const hrId of deciderIds) {
    const key = canonicalHrIdKey(hrId);
    if (key) deciders.set(key, { isCeo: ceoKeys.has(key), name: names.get(hrId) ?? "Name not on file" });
  }

  const requestsById = new Map<string, CeoApprovalRequestInput>(
    requestRows.map((row) => [
      row.id,
      {
        customerId: row.customer_id,
        customerName: (row.customer_id && customerName.get(row.customer_id)) || "Customer not on file",
        estimatedCost: Number(row.estimated_cost ?? 0),
        href: marketingRequestNotificationUrl(row.id),
        id: row.id,
        lineName: cleanText(row.line?.name) || "No line",
        payDate: row.pay_date,
        requestCode: row.request_code,
        requesterHrId: row.requester_hr_id,
        requesterName: names.get(row.requester_hr_id) ?? "Name not on file",
        requestType: marketingRequestActivity(typeName.get(String(row.request_type_id)), row.other_request_type),
        status: row.status,
      },
    ]),
  );

  const rows = buildCeoApprovalRows({
    ceoApprovals,
    deciders,
    requestsById,
    steps,
    todayCairo: todayInCairo(),
  });
  return { generatedAtIso, range, rows };
}
