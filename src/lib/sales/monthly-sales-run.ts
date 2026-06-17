import { writeAuditLog } from "@/lib/admin/audit";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import {
  listMonthlyClosingPeriods,
  listSalesImportDistributors,
  type SalesDistributorOption,
} from "@/lib/sales/monthly-distributor-import";
import { normalizeCodeKey } from "@/lib/sales/normalizer/resolvers";
import { getSupabaseAdmin, rpcAll } from "@/lib/supabase/server";

// ─────────────────────────────────────────────────────────────────────────────
// Monthly Sales guided workflow — resumable run state. A run walks one period distributor-by-
// distributor (pending → uploaded → validated → confirmed, or skipped), with Direct then Office
// pinned to the tail (Office is computed last). Completion % is weighted by each distributor's
// trailing sales share. Locking a period freezes its uploads (enforced in the import service).
// ─────────────────────────────────────────────────────────────────────────────

const PERIOD_RE = /^\d{4}-\d{2}$/;
const TAIL_CODES = ["DIRECT", "OFFICE"]; // normalized; always last, in this order
const TRAILING_PERIODS = 3;
const WEIGHT_FLOOR = 0.001;

export type StepStatus = "pending" | "uploaded" | "validated" | "confirmed" | "skipped";

export type MonthlySalesStep = {
  distributorCode: string;
  distributorName: string;
  stepStatus: StepStatus;
  skipReason: string | null;
  batchId: string | null;
  weight: number;
  ordering: number;
  batch: { fileName: string; period: string | null; status: string; totalQty: number; totalValue: number } | null;
};

export type MonthlySalesRun = {
  id: string;
  period: string;
  status: "in_progress" | "locked" | "reopened";
  locked: boolean;
  lockedBy: string | null;
  lockedAt: string | null;
  completionPct: number;
  steps: MonthlySalesStep[];
};

function assertPeriod(period: string): void {
  if (!PERIOD_RE.test(period)) {
    throw new SalesWorkflowError("invalid_request", "A valid period (YYYY-MM) is required.", 400);
  }
}

// Brick-carrying distributors first (by name), then Direct, then Office.
export function orderDistributors(distributors: SalesDistributorOption[]): SalesDistributorOption[] {
  const head = distributors
    .filter((d) => !TAIL_CODES.includes(normalizeCodeKey(d.code)))
    .sort((a, b) => a.name.localeCompare(b.name));
  const tail: SalesDistributorOption[] = [];
  for (const code of TAIL_CODES) {
    const match = distributors.find((d) => normalizeCodeKey(d.code) === code);
    if (match) tail.push(match);
  }
  return [...head, ...tail];
}

// Trailing share weights normalized to sum 1 across the run's distributors. Falls back to equal
// weights when there is no prior validated history (first close ever).
async function computeDistributorWeights(period: string, orderedCodes: string[]): Promise<Map<string, number>> {
  const supabase = getSupabaseAdmin();
  const allPeriods = await listMonthlyClosingPeriods();
  const prior = allPeriods.filter((p) => p < period).slice(0, TRAILING_PERIODS);

  const shareSumByKey = new Map<string, number>();
  let periodsUsed = 0;
  for (const p of prior) {
    const rows = await rpcAll<{ distributor_code: string; value: number | string }>(
      supabase,
      "phx_exec_distributor_product",
      { p_period: p },
      ["distributor_code", "product_code"],
    );
    const valueByKey = new Map<string, number>();
    let total = 0;
    for (const r of rows) {
      const v = Number(r.value ?? 0);
      if (!(v > 0)) continue;
      const key = normalizeCodeKey(r.distributor_code);
      valueByKey.set(key, (valueByKey.get(key) ?? 0) + v);
      total += v;
    }
    if (!(total > 0)) continue;
    periodsUsed += 1;
    for (const [key, v] of valueByKey) shareSumByKey.set(key, (shareSumByKey.get(key) ?? 0) + v / total);
  }

  const weights = new Map<string, number>();
  if (periodsUsed === 0) {
    const equal = orderedCodes.length > 0 ? 1 / orderedCodes.length : 0;
    for (const code of orderedCodes) weights.set(code, equal);
    return weights;
  }

  const raw = new Map<string, number>();
  let sum = 0;
  for (const code of orderedCodes) {
    const avg = (shareSumByKey.get(normalizeCodeKey(code)) ?? 0) / periodsUsed;
    const w = Math.max(avg, WEIGHT_FLOOR);
    raw.set(code, w);
    sum += w;
  }
  for (const code of orderedCodes) weights.set(code, sum > 0 ? (raw.get(code) ?? 0) / sum : 0);
  return weights;
}

async function loadValidatedBatchesByCode(period: string): Promise<Map<string, { id: string }>> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("source_of_sales_import_batches")
    .select("id,distributor_code")
    .eq("period", period)
    .eq("status", "validated");
  const map = new Map<string, { id: string }>();
  if (error) return map;
  for (const row of data ?? []) {
    map.set(normalizeCodeKey(String(row.distributor_code ?? "")), { id: String(row.id) });
  }
  return map;
}

export async function startOrGetRun(period: string, actorId: string): Promise<MonthlySalesRun> {
  assertPeriod(period);
  const supabase = getSupabaseAdmin();

  const existing = await supabase.from("monthly_sales_run").select("id").eq("period", period).maybeSingle();
  let runId = existing.data ? String(existing.data.id) : "";

  const distributors = await listSalesImportDistributors();
  const ordered = orderDistributors(distributors);

  if (!runId) {
    const inserted = await supabase
      .from("monthly_sales_run")
      .insert({ period, status: "in_progress", created_by: actorId })
      .select("id")
      .single();
    if (inserted.error) throw inserted.error;
    runId = String(inserted.data.id);

    const [weights, validatedBatches] = await Promise.all([
      computeDistributorWeights(period, ordered.map((d) => d.code)),
      loadValidatedBatchesByCode(period),
    ]);

    const stepRows = ordered.map((d, index) => {
      const batch = validatedBatches.get(normalizeCodeKey(d.code));
      return {
        run_id: runId,
        distributor_code: d.code,
        step_status: batch ? "confirmed" : "pending",
        batch_id: batch?.id ?? null,
        weight: weights.get(d.code) ?? 0,
        ordering: index,
      };
    });
    const { error: stepError } = await supabase.from("monthly_sales_run_step").insert(stepRows);
    if (stepError) throw stepError;
  } else {
    // Re-entry: add steps for any distributors registered since, and reconcile each step against the
    // live validated batches (confirm when a batch now exists; reset when its batch was deleted).
    const stepsResult = await supabase
      .from("monthly_sales_run_step")
      .select("distributor_code,step_status,batch_id,weight,ordering")
      .eq("run_id", runId);
    const steps = stepsResult.data ?? [];
    const haveCodes = new Set(steps.map((s) => normalizeCodeKey(String(s.distributor_code ?? ""))));
    const validatedBatches = await loadValidatedBatchesByCode(period);

    const missing = ordered.filter((d) => !haveCodes.has(normalizeCodeKey(d.code)));
    if (missing.length > 0) {
      const weights = await computeDistributorWeights(period, ordered.map((d) => d.code));
      const startIndex = steps.length;
      const newRows = missing.map((d, i) => {
        const batch = validatedBatches.get(normalizeCodeKey(d.code));
        return {
          run_id: runId,
          distributor_code: d.code,
          step_status: batch ? "confirmed" : "pending",
          batch_id: batch?.id ?? null,
          weight: weights.get(d.code) ?? 0,
          ordering: startIndex + i,
        };
      });
      await supabase.from("monthly_sales_run_step").insert(newRows);
    }

    for (const step of steps) {
      const code = normalizeCodeKey(String(step.distributor_code ?? ""));
      const batch = validatedBatches.get(code);
      const status = String(step.step_status ?? "pending");
      if (batch && status !== "skipped" && String(step.batch_id ?? "") !== batch.id) {
        await supabase
          .from("monthly_sales_run_step")
          .update({ step_status: "confirmed", batch_id: batch.id, updated_at: new Date().toISOString() })
          .eq("run_id", runId)
          .eq("distributor_code", String(step.distributor_code));
      } else if (!batch && step.batch_id && status === "confirmed") {
        await supabase
          .from("monthly_sales_run_step")
          .update({ step_status: "pending", batch_id: null, updated_at: new Date().toISOString() })
          .eq("run_id", runId)
          .eq("distributor_code", String(step.distributor_code));
      }
    }
  }

  return loadRun(period);
}

export async function loadRun(period: string): Promise<MonthlySalesRun> {
  assertPeriod(period);
  const supabase = getSupabaseAdmin();

  const runResult = await supabase
    .from("monthly_sales_run")
    .select("id,period,status,locked_by,locked_at")
    .eq("period", period)
    .maybeSingle();
  if (runResult.error) throw runResult.error;
  if (!runResult.data) {
    throw new SalesWorkflowError("not_found", `No Monthly Sales run exists for ${period}.`, 404);
  }
  const runId = String(runResult.data.id);

  const [stepsResult, lockResult, distributors] = await Promise.all([
    supabase
      .from("monthly_sales_run_step")
      .select("distributor_code,step_status,skip_reason,batch_id,weight,ordering")
      .eq("run_id", runId)
      .order("ordering", { ascending: true }),
    supabase.from("monthly_sales_period_lock").select("locked").eq("period", period).maybeSingle(),
    listSalesImportDistributors(),
  ]);
  if (stepsResult.error) throw stepsResult.error;

  const nameByCode = new Map(distributors.map((d) => [normalizeCodeKey(d.code), d.name]));
  const stepRows = stepsResult.data ?? [];
  const batchIds = stepRows.map((s) => s.batch_id).filter(Boolean) as string[];
  const batchById = new Map<string, { fileName: string; period: string | null; status: string; totalQty: number; totalValue: number }>();
  if (batchIds.length > 0) {
    const batchResult = await supabase
      .from("source_of_sales_import_batches")
      .select("id,file_name,period,status,total_qty,total_value")
      .in("id", batchIds);
    for (const row of batchResult.data ?? []) {
      batchById.set(String(row.id), {
        fileName: String(row.file_name ?? ""),
        period: row.period ? String(row.period) : null,
        status: String(row.status ?? ""),
        totalQty: Number(row.total_qty ?? 0),
        totalValue: Number(row.total_value ?? 0),
      });
    }
  }

  const steps: MonthlySalesStep[] = stepRows.map((s) => {
    const code = String(s.distributor_code ?? "");
    const batchId = s.batch_id ? String(s.batch_id) : null;
    return {
      distributorCode: code,
      distributorName: nameByCode.get(normalizeCodeKey(code)) ?? code,
      stepStatus: String(s.step_status ?? "pending") as StepStatus,
      skipReason: s.skip_reason ? String(s.skip_reason) : null,
      batchId,
      weight: Number(s.weight ?? 0),
      ordering: Number(s.ordering ?? 0),
      batch: batchId ? batchById.get(batchId) ?? null : null,
    };
  });

  const doneWeight = steps
    .filter((s) => s.stepStatus === "confirmed" || s.stepStatus === "skipped")
    .reduce((acc, s) => acc + s.weight, 0);
  const completionPct = Math.round(Math.min(1, Math.max(0, doneWeight)) * 100);

  const locked = Boolean(lockResult.data?.locked);
  return {
    id: runId,
    period,
    status: String(runResult.data.status ?? "in_progress") as MonthlySalesRun["status"],
    locked,
    lockedBy: runResult.data.locked_by ? String(runResult.data.locked_by) : null,
    lockedAt: runResult.data.locked_at ? String(runResult.data.locked_at) : null,
    completionPct,
    steps,
  };
}

async function updateStep(period: string, distributorCode: string, patch: Record<string, unknown>): Promise<MonthlySalesRun> {
  assertPeriod(period);
  const supabase = getSupabaseAdmin();
  const runResult = await supabase.from("monthly_sales_run").select("id").eq("period", period).maybeSingle();
  if (runResult.error) throw runResult.error;
  if (!runResult.data) throw new SalesWorkflowError("not_found", `No Monthly Sales run exists for ${period}.`, 404);
  const runId = String(runResult.data.id);

  const { error } = await supabase
    .from("monthly_sales_run_step")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("run_id", runId)
    .eq("distributor_code", distributorCode);
  if (error) throw error;
  return loadRun(period);
}

export async function confirmStep(period: string, distributorCode: string, batchId: string | null): Promise<MonthlySalesRun> {
  return updateStep(period, distributorCode, { step_status: "confirmed", batch_id: batchId, skip_reason: null });
}

export async function skipStep(period: string, distributorCode: string, reason: string): Promise<MonthlySalesRun> {
  const trimmed = String(reason ?? "").trim();
  if (!trimmed) throw new SalesWorkflowError("invalid_request", "A reason is required to skip a distributor.", 400);
  return updateStep(period, distributorCode, { step_status: "skipped", skip_reason: trimmed, batch_id: null });
}

export async function reopenStep(period: string, distributorCode: string): Promise<MonthlySalesRun> {
  return updateStep(period, distributorCode, { step_status: "pending", skip_reason: null, batch_id: null });
}

export async function lockPeriod(period: string, actorId: string): Promise<MonthlySalesRun> {
  assertPeriod(period);
  const run = await loadRun(period);
  const pending = run.steps.filter((s) => s.stepStatus !== "confirmed" && s.stepStatus !== "skipped");
  if (pending.length > 0) {
    throw new SalesWorkflowError(
      "incomplete_close",
      `Cannot lock ${period}: ${pending.length} distributor(s) are not yet confirmed or skipped (${pending.map((s) => s.distributorName).join(", ")}).`,
      409,
    );
  }

  const supabase = getSupabaseAdmin();
  const nowIso = new Date().toISOString();
  const lockUpsert = await supabase
    .from("monthly_sales_period_lock")
    .upsert({ period, locked: true, locked_by: actorId, locked_at: nowIso, reopened_by: null, reopened_at: null }, { onConflict: "period" });
  if (lockUpsert.error) throw lockUpsert.error;

  const runUpdate = await supabase
    .from("monthly_sales_run")
    .update({ status: "locked", locked_by: actorId, locked_at: nowIso, updated_at: nowIso })
    .eq("period", period);
  if (runUpdate.error) throw runUpdate.error;

  await writeAuditLog({
    actorLoginId: actorId,
    entityId: period,
    entityType: "sales_import_batch",
    newValues: { period, source: "monthly_sales_lock" },
    summary: `Monthly Sales period ${period} locked.`,
  });
  return loadRun(period);
}

export async function reopenPeriod(period: string, actorId: string): Promise<MonthlySalesRun> {
  assertPeriod(period);
  const supabase = getSupabaseAdmin();
  const nowIso = new Date().toISOString();
  const lockUpdate = await supabase
    .from("monthly_sales_period_lock")
    .upsert({ period, locked: false, reopened_by: actorId, reopened_at: nowIso }, { onConflict: "period" });
  if (lockUpdate.error) throw lockUpdate.error;

  const runUpdate = await supabase
    .from("monthly_sales_run")
    .update({ status: "reopened", locked_by: null, locked_at: null, updated_at: nowIso })
    .eq("period", period);
  if (runUpdate.error) throw runUpdate.error;

  await writeAuditLog({
    actorLoginId: actorId,
    entityId: period,
    entityType: "sales_import_batch",
    oldValues: { period, source: "monthly_sales_lock" },
    summary: `Monthly Sales period ${period} re-opened.`,
  });
  return loadRun(period);
}
