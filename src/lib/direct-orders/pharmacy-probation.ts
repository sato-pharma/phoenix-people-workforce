import type { AccessContext } from "@/lib/auth/permissions";
import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { bumpCustomer360Cache } from "@/lib/cache/namespaces";
import { forbiddenError } from "@/lib/http/api-errors";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { normalizeVenueType, venueCanAttributeSales, venueTypeLabel } from "@/lib/venues/venue-type";

// ─────────────────────────────────────────────────────────────────────────────
// Probation and the phantom report (spec A3 — docs/specs/direct-orders-v2.md).
//
// A Super Admin approval admits an IDENTITY; it does not make that identity true. The insight the
// whole design rests on: a real pharmacy that received real stock cannot stay invisible. It will
// appear in a distributor's sheet, or its collection will be paid. Either footprint proves it.
//
// So an approved-as-new pharmacy is `provisional` and carries a clock. A footprint promotes it to
// `trusted` automatically. Silence for the whole window promotes nothing — it writes a report
// naming the pharmacy, the orders, the value and the REP, to the owner and the CEO.
//
// This is what makes the gate hold even when the gatekeeper is tired at 11pm: a wrong approval
// self-corrects, and the person who pushed it through knows that in advance.
// ─────────────────────────────────────────────────────────────────────────────

export const PROBATION_DAYS = 90;

export type ProbationSweepResult = {
  checked: number;
  promoted: Array<{ pharmacyId: string; pharmacyName: string; reason: string }>;
  flagged: Array<{
    pharmacyId: string;
    pharmacyName: string;
    phoenixPharmacyCode: string;
    requesterHrId: string | null;
    orders: number;
    salesValue: number;
    daysOnProbation: number;
  }>;
};

function assertSweepAccess(access: AccessContext): void {
  if (!(access.scope === "system" || access.role === "Super Admin")) {
    throw forbiddenError("Forbidden: only the system or a Super Admin can run the probation sweep.");
  }
}

/**
 * Has this pharmacy left a footprint since it went on probation?
 *
 * TWO independent proofs, and either is enough:
 *   1. distributor sales — the pharmacy's customer code appears in the SoS import rows;
 *   2. money — one of its direct orders has been paid.
 *
 * Deliberately generous: the question is "does this place exist and trade", not "did it behave
 * exactly as predicted". A phantom satisfies NEITHER, which is what makes silence meaningful.
 */
async function findFootprint(input: {
  pharmacyId: string;
  since: string;
}): Promise<{ found: boolean; reason: string }> {
  const supabase = getSupabaseAdmin();

  const { data: codes } = await supabase
    .from("direct_order_pharmacy_distributor_codes")
    .select("distributor_code, customer_code")
    .eq("pharmacy_id", input.pharmacyId);
  const pairs = ((codes ?? []) as Array<{ distributor_code: string; customer_code: string }>).filter(
    (c) => c.distributor_code && c.customer_code,
  );

  for (const pair of pairs) {
    // `client_code`, NOT `customer_code`. The SoS import table has no column by the latter name —
    // that is what the DIRECT-ORDER side calls it. PostgREST answers an unknown column with an
    // error and no count, and the old code read `count ?? 0`, so every lookup silently returned
    // "no footprint" and the promotion path could never fire once. Two live pharmacies had
    // footprints the whole time (IS/348325, PS/0001559824 — 23 rows between them).
    const { count, error } = await supabase
      .from("source_of_sales_import_rows")
      .select("id", { count: "exact", head: true })
      .eq("distributor_code", pair.distributor_code)
      .eq("client_code", pair.customer_code)
      .limit(1);
    // Never swallow this again: a footprint we FAILED to look up is not a footprint we know is
    // absent, and the difference decides whether a real pharmacy gets reported as a phantom.
    if (error) throw error;
    if ((count ?? 0) > 0) {
      return { found: true, reason: `Distributor sales recorded for ${pair.distributor_code}/${pair.customer_code}` };
    }
  }

  const { data: paid } = await supabase
    .from("direct_order_requests")
    .select("id, payment_date, paid_amount")
    .eq("pharmacy_id", input.pharmacyId)
    .not("payment_date", "is", null)
    .limit(1);
  if ((paid ?? []).length > 0) {
    return { found: true, reason: "A direct order for this pharmacy has been paid" };
  }

  return { found: false, reason: "" };
}

/**
 * The daily probation sweep (spec A3).
 *
 * Promotes any provisional pharmacy that has earned a footprint, and reports any whose window has
 * closed in silence. Both outcomes are recorded — a probation that simply lapsed with nothing
 * written would be the same silence the module exists to end.
 */
export async function runDirectOrderProbationSweep(
  access: AccessContext,
  input?: { now?: Date; probationDays?: number },
): Promise<ProbationSweepResult> {
  assertSweepAccess(access);
  const days = input?.probationDays ?? PROBATION_DAYS;
  const now = input?.now ?? new Date();
  const deadline = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("direct_order_pharmacies")
    .select("id, pharmacy_name, phoenix_pharmacy_code, probation_started_at, created_by_hr_id, venue_type")
    .eq("trust_state", "provisional")
    .eq("active", true);
  if (error) throw error;

  const rows = (data ?? []) as Array<{
    id: string;
    pharmacy_name: string | null;
    phoenix_pharmacy_code: string | null;
    probation_started_at: string | null;
    venue_type?: string | null;
    created_by_hr_id: string | null;
  }>;

  const result: ProbationSweepResult = { checked: rows.length, promoted: [], flagged: [] };

  for (const row of rows) {
    const startedAt = row.probation_started_at ? new Date(row.probation_started_at) : null;
    try {
      const footprint = await findFootprint({ pharmacyId: row.id, since: row.probation_started_at ?? "" });

      if (footprint.found) {
        await supabase
          .from("direct_order_pharmacies")
          .update({
            trust_state: "trusted",
            trusted_at: now.toISOString(),
            trusted_reason: footprint.reason,
          })
          .eq("id", row.id)
          .eq("trust_state", "provisional");
        await writeRequiredAuditLog({
          actorLoginId: access.loginId ?? access.hrId,
          entityType: "direct_order_request",
          entityId: `pharmacy:${row.id}`,
          oldValues: { trustState: "provisional" },
          newValues: { trustState: "trusted", reason: footprint.reason },
          summary: `Pharmacy ${row.pharmacy_name ?? row.id} left probation: ${footprint.reason}.`,
        });
        result.promoted.push({ pharmacyId: row.id, pharmacyName: row.pharmacy_name ?? row.id, reason: footprint.reason });
        continue;
      }

      // Still inside the window with no footprint yet — that is normal, not a finding.
      if (!startedAt || startedAt > deadline) continue;

      const { data: orders } = await supabase
        .from("direct_order_requests")
        .select("id, sales_value, requester_hr_id")
        .eq("pharmacy_id", row.id);
      const orderRows = (orders ?? []) as Array<{ sales_value: unknown; requester_hr_id: string | null }>;
      const salesValue = orderRows.reduce((sum, o) => sum + (Number(o.sales_value) || 0), 0);
      const daysOnProbation = Math.floor((now.getTime() - startedAt.getTime()) / (24 * 60 * 60 * 1000));
      // Half of "no footprint" is unreachable for a venue with no distributor account: a nursery
      // can never appear in the SoS import rows however real it is, so the sentence "no distributor
      // sales" would read as evidence against it when it is simply not a test it can sit. Say which
      // proof was actually available, or the reviewer draws a conclusion the data does not support.
      const venueType = normalizeVenueType(row.venue_type);
      const missingProof = venueCanAttributeSales(venueType)
        ? "no distributor sales and no payment"
        : `no payment (a ${venueTypeLabel(venueType).toLowerCase()} has no distributor account, so distributor sales can never appear for it)`;

      await supabase
        .from("direct_order_pharmacies")
        .update({ trust_state: "phantom_suspected", phantom_reported_at: now.toISOString() })
        .eq("id", row.id)
        .eq("trust_state", "provisional");

      await writeRequiredAuditLog({
        actorLoginId: access.loginId ?? access.hrId,
        entityType: "direct_order_request",
        entityId: `pharmacy:${row.id}`,
        oldValues: { trustState: "provisional" },
        newValues: { trustState: "phantom_suspected", daysOnProbation, orders: orderRows.length, salesValue, venueType },
        summary:
          `${venueTypeLabel(venueType)} ${row.pharmacy_name ?? row.id} completed ${daysOnProbation} days on probation ` +
          `with ${missingProof}. ${orderRows.length} order(s), ${Math.round(salesValue).toLocaleString("en-US")} EGP.`,
      });

      result.flagged.push({
        pharmacyId: row.id,
        pharmacyName: row.pharmacy_name ?? row.id,
        phoenixPharmacyCode: row.phoenix_pharmacy_code ?? "—",
        requesterHrId: orderRows[0]?.requester_hr_id ?? row.created_by_hr_id,
        orders: orderRows.length,
        salesValue,
        daysOnProbation,
      });
    } catch (sweepError) {
      // One pharmacy must never abort the sweep — the rest still need checking tonight.
      logError("Probation check failed for a pharmacy; the sweep continued", {
        labels: { event: "direct_order_probation_check_failed", pharmacyId: row.id },
        error: sweepError,
      });
    }
  }

  if (result.promoted.length > 0) bumpCustomer360Cache("direct-order pharmacies promoted to trusted");
  return result;
}
