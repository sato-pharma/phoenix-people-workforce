import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { computeDirectOrderSalesValue } from "@/lib/direct-orders/approval-flow";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "direct-orders-pharmacy-price-backfill",
  entry: import.meta.url,
  known: ["--apply", "--confirm-restates-achievement", "--project-ref", "--backup-dir", "--help", "-h"],
});

// ─────────────────────────────────────────────────────────────────────────────
// Recompute direct-order sales values onto the PHARMACY price.
//
// Owner approval: 2026-08-03. Bonus direct orders moved from `qty × factory price` to
// `qty × pharmacy price` (PR #1664). Orders submitted BEFORE their product had a pharmacy
// price were valued at the factory price and stamped `pharmacy_price_snapshot = null`.
// This script re-values them from today's pharmacy price and re-injects the affected months.
//
// WHAT THIS TOUCHES, AND WHY IT MATTERS
//
//   An APPROVED order's sales_value has already been injected into Source of Sales, which
//   feeds au.f_monthly_attribution and therefore achievement and incentives. Re-valuing one
//   RESTATES a month that people may already have been paid against. That is the reason this
//   is a hand-run script behind two flags and not a migration.
//
//   A PENDING order has injected nothing yet, so re-valuing it changes no reported number —
//   but it is the more useful case in practice: it stops a stale factory-price value from
//   being locked in the moment the CEO approves.
//
// DISCOUNT ORDERS ARE NEVER TOUCHED. They price on the public price and that did not change.
//
// REVERSALS ARE EXCLUDED, and this is not cosmetic: reverseDirectOrder does not copy
// `deal_type`, so EVERY reversal row reads 'bonus' by column default even when it reverses a
// discount order. A truth set of `deal_type = 'bonus'` alone would recompute those rows and
// destroy their mirror-of-original value. Filter on `reversal_of_request_id is null` too.
//
// Usage:
//   preview                      read-only; prints the per-month delta you sign off on
//   apply --apply --confirm-restates-achievement
//
// The two flags are deliberately separate: --apply says "write", the second says "I understand
// this restates achievement". Neither alone is enough.
// ─────────────────────────────────────────────────────────────────────────────

const PRODUCTION_REF = "ozucdzovmcqvepbozvqf";

/**
 * Statuses whose value is worth correcting.
 *
 * `approved` is the money — restating it is the whole point, and the risk.
 * `pending_approval` / `returned` / `draft` are still in flight and should finalize on the
 * right basis rather than lock in a stale one.
 * `rejected` and `reversed` are deliberately absent: they are records of a decision taken
 * against the old number, with no money effect. Rewriting them changes history for nothing.
 */
const RECOMPUTE_STATUSES = ["approved", "pending_approval", "returned", "draft"] as const;

type RequestRow = {
  id: string;
  product_code: string;
  product_name: string;
  status: string;
  qty: number | string;
  bonus: number | string;
  sales_value: number | string;
  sales_month: string | null;
  pharmacy_price_snapshot: number | string | null;
  sos_batch_id: string | null;
  reversal_of_request_id: string | null;
};

type Change = {
  id: string;
  productCode: string;
  productName: string;
  status: string;
  salesMonth: string | null;
  qty: number;
  oldSalesValue: number;
  newSalesValue: number;
  delta: number;
  oldBasis: "factory_price" | "pharmacy_price";
  pharmacyPrice: number;
};

type Skip = { id: string; productCode: string; productName: string; reason: string };

function usage(): never {
  console.log(`
Direct Orders — recompute sales values onto the pharmacy price

Commands:
  preview
  apply --apply --confirm-restates-achievement [--backup-dir <dir>]

Notes:
  - preview is read-only and prints the per-month delta to sign off on.
  - apply refuses to run without BOTH flags.
  - apply writes a JSON pre-image (including sos_batch_id) before touching anything.
  - discount orders, reversals, rejected and reversed orders are never touched.
  - products with no pharmacy price are SKIPPED and reported, never silently left behind.
`);
  process.exit(1);
}

function parseArgs() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") usage();
  const options: Record<string, string | boolean> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = rest[index + 1];
    if (next && !next.startsWith("--")) {
      options[key] = next;
      index += 1;
    } else {
      options[key] = true;
    }
  }
  return { command, options };
}

function currentProjectRef(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  return url.replace(/^https:\/\//, "").split(".")[0] ?? "";
}

function client(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

const num = (value: number | string | null | undefined): number => {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};
const money = (value: number): string => value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Every candidate row plus today's pharmacy price per product. */
async function loadCandidates(supabase: SupabaseClient) {
  const { data: requestData, error: requestError } = await supabase
    .from("direct_order_requests")
    .select(
      "id, product_code, product_name, status, qty, bonus, sales_value, sales_month, pharmacy_price_snapshot, sos_batch_id, reversal_of_request_id",
    )
    .eq("deal_type", "bonus")
    // See the header: reversal rows read deal_type 'bonus' regardless of what they reverse.
    .is("reversal_of_request_id", null)
    .in("status", RECOMPUTE_STATUSES as unknown as string[])
    .order("created_at", { ascending: true });
  if (requestError) throw new Error(`Loading requests failed: ${requestError.message}`);

  const { data: productData, error: productError } = await supabase
    .from("source_of_sales_products")
    .select("product_code, pharmacy_price");
  if (productError) throw new Error(`Loading products failed: ${productError.message}`);

  const pharmacyPriceByCode = new Map<string, number | null>();
  for (const row of (productData ?? []) as Array<{ product_code: string; pharmacy_price: number | string | null }>) {
    const raw = row.pharmacy_price == null ? null : Number(row.pharmacy_price);
    pharmacyPriceByCode.set(row.product_code, raw != null && Number.isFinite(raw) && raw > 0 ? raw : null);
  }

  return { requests: (requestData ?? []) as RequestRow[], pharmacyPriceByCode };
}

/** Pure: decide what each candidate becomes. No writes, no side effects. */
function planChanges(requests: RequestRow[], pharmacyPriceByCode: Map<string, number | null>) {
  const changes: Change[] = [];
  const skips: Skip[] = [];

  for (const request of requests) {
    const pharmacyPrice = pharmacyPriceByCode.get(request.product_code) ?? null;
    if (pharmacyPrice == null) {
      // Loud, never silent: a missing price means this product was never configured, and
      // leaving the row on the old basis without saying so is how a restatement half-happens.
      skips.push({
        id: request.id,
        productCode: request.product_code,
        productName: request.product_name,
        reason: "no pharmacy price set for this product",
      });
      continue;
    }

    const qty = num(request.qty);
    // The domain function, never a re-derived formula — if the rule changes, this follows it.
    const newSalesValue = computeDirectOrderSalesValue({ qty, pharmacyPrice });
    const oldSalesValue = num(request.sales_value);
    if (newSalesValue === oldSalesValue && request.pharmacy_price_snapshot != null) continue;

    changes.push({
      id: request.id,
      productCode: request.product_code,
      productName: request.product_name,
      status: request.status,
      salesMonth: request.sales_month,
      qty,
      oldSalesValue,
      newSalesValue,
      delta: Math.round((newSalesValue - oldSalesValue) * 100) / 100,
      oldBasis: request.pharmacy_price_snapshot == null ? "factory_price" : "pharmacy_price",
      pharmacyPrice,
    });
  }

  return { changes, skips };
}

/** The table the owner actually signs off on: what moves, per month, and by how much. */
function reportPerMonth(changes: Change[]) {
  const byMonth = new Map<string, { orders: number; oldValue: number; newValue: number; approved: number }>();
  for (const change of changes) {
    // An order with no month injects into no period — group it separately rather than
    // pretending it belongs to one.
    const key = change.salesMonth ?? "(not booked into a month)";
    const bucket = byMonth.get(key) ?? { orders: 0, oldValue: 0, newValue: 0, approved: 0 };
    bucket.orders += 1;
    bucket.oldValue += change.oldSalesValue;
    bucket.newValue += change.newSalesValue;
    if (change.status === "approved") bucket.approved += 1;
    byMonth.set(key, bucket);
  }

  console.log("\nPer-month delta (approved orders are the ones that restate reported sales):");
  console.log("  month                        orders  approved            old            new          delta");
  for (const key of [...byMonth.keys()].sort()) {
    const b = byMonth.get(key)!;
    const delta = b.newValue - b.oldValue;
    console.log(
      `  ${key.padEnd(26)} ${String(b.orders).padStart(6)} ${String(b.approved).padStart(9)} ` +
        `${money(b.oldValue).padStart(14)} ${money(b.newValue).padStart(14)} ${money(delta).padStart(14)}`,
    );
  }
  return byMonth;
}

async function main() {
  const { command, options } = parseArgs();
  if (command !== "preview" && command !== "apply") usage();

  const ref = currentProjectRef();
  console.log(`Supabase project ref: ${ref}${ref === PRODUCTION_REF ? " (PRODUCTION)" : ""}`);

  const supabase = client();
  const { requests, pharmacyPriceByCode } = await loadCandidates(supabase);
  const { changes, skips } = planChanges(requests, pharmacyPriceByCode);

  console.log(`\nCandidates (bonus, non-reversal, status in ${RECOMPUTE_STATUSES.join("/")}): ${requests.length}`);
  console.log(`Would change: ${changes.length}`);
  console.log(`Skipped (no pharmacy price): ${skips.length}`);
  for (const skip of skips) console.log(`  SKIP ${skip.id}  ${skip.productName} (${skip.productCode}) — ${skip.reason}`);

  if (changes.length === 0) {
    console.log("\nNothing to recompute. Set pharmacy prices first, then re-run preview.");
    return;
  }

  reportPerMonth(changes);
  const approvedChanges = changes.filter((change) => change.status === "approved");
  console.log(
    `\n${approvedChanges.length} of ${changes.length} changes are on APPROVED orders — only those restate reported sales and achievement.`,
  );

  if (command === "preview") {
    console.log("\nPreview only. Nothing was written. Re-run with:");
    console.log("  apply --apply --confirm-restates-achievement");
    return;
  }

  if (options.apply !== true || options["confirm-restates-achievement"] !== true) {
    throw new Error("Refusing to write: apply needs BOTH --apply and --confirm-restates-achievement.");
  }
  if (ref === PRODUCTION_REF && options["project-ref"] !== PRODUCTION_REF) {
    throw new Error(`Refusing to write to PRODUCTION without --project-ref ${PRODUCTION_REF}.`);
  }

  // Pre-image FIRST. sos_batch_id matters: the rebuild re-stamps it, so this file is the only
  // record of which batch a request previously belonged to.
  const backupDir = String(options["backup-dir"] ?? "outputs/direct-orders-pharmacy-price-backfill");
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const preImagePath = path.join(backupDir, `rows-before-${stamp}.json`);
  writeFileSync(preImagePath, JSON.stringify({ ref, takenAt: stamp, requests, changes, skips }, null, 2), "utf8");
  console.log(`\nPre-image written: ${preImagePath}`);

  let written = 0;
  for (const change of changes) {
    const { error } = await supabase
      .from("direct_order_requests")
      .update({
        sales_value: change.newSalesValue,
        pharmacy_price_snapshot: change.pharmacyPrice,
        updated_at: new Date().toISOString(),
      })
      .eq("id", change.id);
    if (error) throw new Error(`Updating ${change.id} failed: ${error.message}`);
    written += 1;
  }
  console.log(`Updated ${written} request(s).`);

  // Re-inject every affected month. Only APPROVED orders are in a Source-of-Sales batch, and
  // only a booked month has one at all. Sequential because the RPC takes a per-period advisory
  // lock; each call is its own transaction, so a failure leaves earlier periods consistent.
  const periods = [
    ...new Set(approvedChanges.map((change) => change.salesMonth).filter((month): month is string => Boolean(month))),
  ].sort();
  if (periods.length === 0) {
    console.log("No approved orders with a booked month — nothing to re-inject.");
  }
  for (const period of periods) {
    const { data, error } = await supabase.rpc("phx_rebuild_direct_order_sos_batch", {
      p_period: period,
      p_actor: "pharmacy-price-backfill",
    });
    if (error) throw new Error(`Rebuilding ${period} failed: ${error.message}`);
    console.log(`Rebuilt ${period}: ${JSON.stringify(data)}`);
  }

  console.log("\nDone. Verify: per-month sums, then the achievement figure for any month above.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
