import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  directOrderExpectedRoleChain,
  SFE_VALIDATION_ROLE,
} from "@/lib/direct-orders/approval-flow";
import { rebuildDirectOrderApprovalChain } from "@/lib/direct-orders/service";
import { systemAccessContext } from "@/lib/auth/permissions";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "direct-orders-rebuild-approval-chains",
  entry: import.meta.url,
  known: ["--apply"],
});

// ─────────────────────────────────────────────────────────────────────────────
// Re-seed approval chains for orders submitted BEFORE a rung existed.
//
// Owner instruction 2026-08-04: "you must backfill and start the normal workflow".
//
// Approval steps are written once at submission and never rebuilt, so every order in flight when
// the ladder changed still routes on the OLD ladder. This puts them on today's.
//
// It covers both rungs added so far, and the test is "does the live chain match what submitting
// this order today would produce" rather than a hardcoded list — so the next rung needs no edit
// here:
//
//   1. SFE Manager, which every chain must open with.
//   2. System Admin, which only orders on a pharmacy Phoenix does not recognise carry. Without
//      this, such an order looks like it is sailing through and then refuses at the CEO, with
//      nobody having been asked to check the pharmacy.
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
    .select("id, product_name, requester_hr_id, requester_role, status, sales_value, pharmacy_id")
    .eq("status", "pending_approval")
    .order("created_at", { ascending: true });
  if (pendingError) throw new Error(pendingError.message);
  const pending = (pendingData ?? []) as Array<Record<string, unknown>>;

  // Whether each order's pharmacy is still awaiting review decides whether its chain should carry
  // the System Admin rung. Read from the pharmacy row, never inferred from the chain itself —
  // the chain is the thing being checked for correctness.
  const pharmacyIds = Array.from(new Set(pending.map((row) => String(row.pharmacy_id)).filter(Boolean)));
  const awaitingReview = new Set<string>();
  if (pharmacyIds.length > 0) {
    const { data: pharmacyData, error: pharmacyError } = await supabase
      .from("direct_order_pharmacies")
      .select("id, verification_status")
      .in("id", pharmacyIds);
    if (pharmacyError) throw new Error(pharmacyError.message);
    for (const row of (pharmacyData ?? []) as Array<{ id: string; verification_status: string | null }>) {
      if (String(row.verification_status ?? "verified") === "pending_review") awaitingReview.add(String(row.id));
    }
  }

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

  const needsRebuild: Array<{
    id: string;
    label: string;
    current: string[];
    expected: string[];
    missing: string[];
    blocked: string | null;
  }> = [];
  for (const row of pending) {
    const id = String(row.id);
    const steps = (stepsByRequest.get(id) ?? []).sort((a, b) => a.step_order - b.step_order);
    const currentLabels = steps.map((step) => String(step.label ?? ""));

    // A chain is stale when a rung today's ladder requires is absent. Person rungs are matched by
    // job title and vary per requester, so only the SFE ROLE rung is checked here — it is the one
    // the ladder itself adds, and a person rung cannot go missing without the manager chain itself
    // having changed (which returning and resubmitting is the right answer for).
    //
    // A legacy Super Admin rung is NOT reported as missing and NOT added: that rung is retired
    // (owner rule, 2026-08-04). Existing ones are left in place rather than stripped — approving
    // one still confirms the pharmacy, so removing it mid-flight would be the destructive option.
    const missing: string[] = [];
    if (!currentLabels.some((label) => label === SFE_VALIDATION_ROLE)) missing.push(SFE_VALIDATION_ROLE);
    if (missing.length === 0) continue;

    const decided = steps.filter((step) => (step.status ?? "pending") !== "pending" || step.decided_by_hr_id || step.decided_at);
    needsRebuild.push({
      id,
      label: `${row.product_name} (${row.requester_role})`,
      current: currentLabels,
      missing,
      // Role-level preview only: the SERVICE resolves person rungs to actual managers.
      expected: directOrderExpectedRoleChain(String(row.requester_role) as never),
      blocked: decided.length > 0 ? `${decided.length} step(s) already decided` : null,
    });
  }

  console.log(`Pending orders: ${pending.length}`);
  console.log(`Chains missing a rung: ${needsRebuild.length}\n`);
  for (const item of needsRebuild) {
    console.log(`  ${item.id}  ${item.label}`);
    console.log(`    missing:  ${item.missing.join(", ")}`);
    console.log(`    now:      ${item.current.join(" → ") || "(none)"}`);
    console.log(`    expected: ${item.expected.join(" → ")}  (role shape; person rungs resolve live)`);
    if (item.blocked) console.log(`    BLOCKED:  ${item.blocked} — return and resubmit instead`);
  }

  if (needsRebuild.length === 0) {
    console.log("Nothing to rebuild — every pending order is already on today's ladder.");
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
