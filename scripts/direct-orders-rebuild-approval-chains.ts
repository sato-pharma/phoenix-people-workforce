import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { directOrderExpectedRoleChain, SFE_VALIDATION_ROLE } from "@/lib/direct-orders/approval-flow";
import { rebuildDirectOrderApprovalChain } from "@/lib/direct-orders/service";
import { systemAccessContext } from "@/lib/auth/permissions";

// ─────────────────────────────────────────────────────────────────────────────
// Re-seed approval chains for orders submitted BEFORE the SFE validation rung existed.
//
// Owner instruction 2026-08-04: "you must backfill and start the normal workflow".
//
// Approval steps are written once at submission and never rebuilt, so every order in flight when
// the ladder changed still routes straight past SFE. This puts them on today's ladder.
//
// SAFETY — the service refuses any chain where a step has already been DECIDED, because deleting
// a decided step erases a real person's approval. This script therefore cannot silently discard
// a decision; the worst case is that it declines an order and says so.
//
// Usage:
//   preview            read-only; shows old chain -> new chain per order
//   apply --apply      rebuilds, and notifies the new first rung
// ─────────────────────────────────────────────────────────────────────────────

const PRODUCTION_REF = "ozucdzovmcqvepbozvqf";

type StepRow = { request_id: string; step_order: number; label: string | null; status: string | null; decided_by_hr_id: string | null; decided_at: string | null };

function currentProjectRef(): string {
  return (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/^https:\/\//, "").split(".")[0] ?? "";
}

function client(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  if (command !== "preview" && command !== "apply") {
    console.log("\nUsage:\n  preview\n  apply --apply\n");
    process.exit(1);
  }
  const ref = currentProjectRef();
  console.log(`Supabase project ref: ${ref}${ref === PRODUCTION_REF ? " (PRODUCTION)" : ""}\n`);

  const supabase = client();
  const { data: pendingData, error: pendingError } = await supabase
    .from("direct_order_requests")
    .select("id, product_name, requester_hr_id, requester_role, status, sales_value")
    .eq("status", "pending_approval")
    .order("created_at", { ascending: true });
  if (pendingError) throw new Error(pendingError.message);
  const pending = (pendingData ?? []) as Array<Record<string, unknown>>;

  const { data: stepData, error: stepError } = await supabase
    .from("direct_order_approval_steps")
    .select("request_id, step_order, label, status, decided_by_hr_id, decided_at")
    .in("request_id", pending.map((row) => String(row.id)));
  if (stepError) throw new Error(stepError.message);
  const stepsByRequest = new Map<string, StepRow[]>();
  for (const row of (stepData ?? []) as StepRow[]) {
    const bucket = stepsByRequest.get(row.request_id) ?? [];
    bucket.push(row);
    stepsByRequest.set(row.request_id, bucket);
  }

  const needsRebuild: Array<{ id: string; label: string; current: string[]; expected: string[]; blocked: string | null }> = [];
  for (const row of pending) {
    const id = String(row.id);
    const steps = (stepsByRequest.get(id) ?? []).sort((a, b) => a.step_order - b.step_order);
    const currentLabels = steps.map((step) => String(step.label ?? ""));
    const hasSfe = steps.some((step) => String(step.label ?? "") === SFE_VALIDATION_ROLE);
    if (hasSfe) continue;

    const decided = steps.filter((step) => (step.status ?? "pending") !== "pending" || step.decided_by_hr_id || step.decided_at);
    needsRebuild.push({
      id,
      label: `${row.product_name} (${row.requester_role})`,
      current: currentLabels,
      // Role-level preview only: the SERVICE resolves person rungs to actual managers.
      expected: directOrderExpectedRoleChain(String(row.requester_role) as never),
      blocked: decided.length > 0 ? `${decided.length} step(s) already decided` : null,
    });
  }

  console.log(`Pending orders: ${pending.length}`);
  console.log(`Missing the SFE rung: ${needsRebuild.length}\n`);
  for (const item of needsRebuild) {
    console.log(`  ${item.id}  ${item.label}`);
    console.log(`    now:      ${item.current.join(" → ") || "(none)"}`);
    console.log(`    expected: ${item.expected.join(" → ")}  (role shape; person rungs resolve live)`);
    if (item.blocked) console.log(`    BLOCKED:  ${item.blocked} — return and resubmit instead`);
  }

  if (needsRebuild.length === 0) {
    console.log("Nothing to rebuild — every pending order already opens with SFE.");
    return;
  }
  if (command === "preview") {
    console.log("\nPreview only. Nothing was written. Re-run with:  apply --apply");
    return;
  }
  if (!args.includes("--apply")) throw new Error("Refusing to write without --apply.");

  for (const item of needsRebuild) {
    if (item.blocked) {
      console.log(`SKIP ${item.id} — ${item.blocked}`);
      continue;
    }
    const result = await rebuildDirectOrderApprovalChain(systemAccessContext, { requestId: item.id });
    console.log(`REBUILT ${result.requestId}: ${result.previousLabels.join(" → ") || "(none)"} → ${result.nextLabels.join(" → ")}`);
  }
  console.log("\nDone. The new first rung has been notified on each rebuilt order.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
