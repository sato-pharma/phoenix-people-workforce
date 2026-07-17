// Post-upload health check for the marketing ROI pipeline. Run after every monthly
// Sales Upload to confirm ROI updated and nothing was silently dropped.
//   pnpm run marketing:roi-verify
// Read-only: calls the STABLE function public.phx_marketing_roi_health().

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { getSupabaseAdmin } from "@/lib/supabase/server";

function loadEnvLocal() {
  const candidates = [
    process.env.MARKETING_ENV_FILE,
    path.resolve(process.cwd(), ".env.local"),
    path.resolve(process.cwd(), "..", "phoenix-workforce", ".env.local"),
  ].filter((value): value is string => Boolean(value));
  const file = candidates.find((candidate) => existsSync(candidate));
  if (!file) return;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvLocal();

const money = (n: unknown) => Number(n ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// The health function recomputes attribution; allow generous time (like the dashboard RPC).
const { data, error } = await getSupabaseAdmin({ requestTimeoutMs: 120000 }).rpc("phx_marketing_roi_health");
if (error) {
  console.error("Health check failed to run:", error.message);
  process.exitCode = 1;
} else {
  const h = data as Record<string, unknown>;
  const dc = (h.double_count ?? {}) as Record<string, unknown>;
  const orphans = (h.unbridged_distributor_codes_with_volume ?? []) as Array<{ code: string; rows: number }>;
  const unbridgedProducts = (h.unbridged_marketing_products ?? []) as string[];
  const nonNumeric = (h.requests_with_only_nonnumeric_codes ?? []) as string[];
  const periods = (h.validated_periods ?? []) as Array<{ period: string; rows: number }>;
  const byStatus = (h.roi_by_status ?? []) as Array<{ status: string; reqs_with_value: number; value: number }>;

  console.log("=== Marketing ROI — post-upload health check ===");
  console.log(`generated: ${h.generated_at}`);
  console.log(`\nValidated sales months: ${periods.map((p) => `${p.period} (${p.rows})`).join(", ") || "none"}`);
  console.log(`Blocked/non-validated batches: ${h.blocked_batches}  ${Number(h.blocked_batches) === 0 ? "OK" : "⚠ silent suppression!"}`);

  console.log(`\nAttributed sales by request status:`);
  for (const s of byStatus) console.log(`  ${s.status.padEnd(16)} ${String(s.reqs_with_value).padStart(3)} reqs   EGP ${money(s.value)}`);
  console.log(`  Dashboard headline (approved): EGP ${money(h.dashboard_headline_value)}`);
  console.log(`  True matched total (all):      EGP ${money(h.true_matched_total)}`);
  console.log(`  Hidden in pending approval:    EGP ${money(h.hidden_pending_value)}`);

  console.log(`\nDouble-count guard: overcount=${dc.overcount} shared_rows=${dc.rows_shared_by_multiple_requests}  ${Number(dc.overcount) === 0 && Number(dc.rows_shared_by_multiple_requests) === 0 ? "OK" : "⚠ company total inflated!"}`);
  if (orphans.length) console.log(`\nDistributor codes carrying validated sales that DON'T attribute (need a rollup/mapping):\n  ${orphans.map((o) => `${o.code}(${o.rows})`).join(", ")}`);
  if (unbridgedProducts.length) console.log(`\nPromoted products that don't bridge to a sales product (name mismatch): ${unbridgedProducts.join(", ")}`);
  if (nonNumeric.length) console.log(`\nRequests whose only pharmacy code is non-numeric (can never attribute): ${nonNumeric.join(", ")}`);

  const pass = Boolean(h.overall_pass);
  console.log(`\n=== ${pass ? "PASS — hard invariants hold (no blocked batch, no double-count)" : "FAIL — investigate before trusting the dashboard"} ===`);
  if (!pass) process.exitCode = 1;
}
