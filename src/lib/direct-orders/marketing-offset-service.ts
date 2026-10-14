/**
 * Settling a marketing request against a direct order's debt — the write side and its readers.
 *
 * WHY THIS IS NOT A COLLECTION. A direct order's `paid_amount` is cash that arrived, and the
 * phantom-pharmacy check reads `payment_date` as proof it did. When a hospital pays net of a sum it
 * owes a doctor on the company's behalf, no cash arrived for that sum and none is paid out either:
 * the order's debt simply falls, and the marketing request is settled by it. That is recorded in
 * `direct_order_marketing_offsets` through `phx_record_direct_order_offset`, which locks both rows
 * and rewrites the order's remainder in the same transaction. Rules and error words:
 * offset-rules.ts. The authority to do it is Finance's, the same as recording a collection.
 */

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import type { AccessContext } from "@/lib/auth/permissions";
import { assertPermission } from "@/lib/auth/permissions";
import { canRecordDirectOrderCollection } from "@/lib/direct-orders/finance-authority";
import {
  deriveOutstandingAmount,
  isMissingOffsetTableError,
  offsetErrorMessage,
} from "@/lib/direct-orders/offset-rules";
import { pingDirectOrderSheet } from "@/lib/direct-orders/sheet-webhook";
import { forbiddenError, validationError } from "@/lib/http/api-errors";
import { hrIdForStorage } from "@/lib/hr-id";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type DirectOrderOffsetCandidate = {
  id: string;
  /** "Pharmacy — doctor", never an id. */
  label: string;
  salesMonth: string | null;
  salesValue: number;
  /** Value less cash collected less offsets already recorded. */
  outstanding: number;
};

export type MarketingRequestOffset = {
  amount: number;
  directOrderId: string;
  /** The order in words, so the Approved tab never prints an id. */
  orderLabel: string;
  note: string | null;
};

type OffsetRow = {
  amount: number | string;
  direct_order_id: string;
  marketing_request_id: string;
  note: string | null;
};

type OrderRow = {
  id: string;
  pharmacy_id: string | null;
  sales_month: string | null;
  sales_value: number | string | null;
  paid_amount: number | string | null;
  status: string | null;
};

type PharmacyRow = { id: string; pharmacy_name: string | null; doctor_name: string | null };

function assertCanSettle(access: AccessContext) {
  if (!canRecordDirectOrderCollection(access)) {
    throw forbiddenError("Forbidden: only Finance (Ahmed El Maraghy) or a System Admin can settle a request against a direct order.");
  }
}

function orderLabel(pharmacy: PharmacyRow | undefined): string {
  const name = pharmacy?.pharmacy_name?.trim() || "Unknown pharmacy";
  const doctor = pharmacy?.doctor_name?.trim();
  return doctor ? `${name} — ${doctor}` : name;
}

async function loadPharmacies(ids: string[]): Promise<Map<string, PharmacyRow>> {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (unique.length === 0) return new Map();
  const { data, error } = await getSupabaseAdmin()
    .from("direct_order_pharmacies")
    .select("id, pharmacy_name, doctor_name")
    .in("id", unique);
  if (error) throw error;
  return new Map(((data ?? []) as PharmacyRow[]).map((row) => [row.id, row]));
}

/** Total settled against one order. Zero when the offsets table is not applied yet. */
export async function loadOffsetTotalForOrder(orderId: string): Promise<number> {
  const { data, error } = await getSupabaseAdmin()
    .from("direct_order_marketing_offsets")
    .select("amount")
    .eq("direct_order_id", orderId);
  if (error) {
    if (isMissingOffsetTableError(error)) return 0;
    throw error;
  }
  return ((data ?? []) as Array<{ amount: number | string }>).reduce((sum, row) => sum + Number(row.amount), 0);
}

/** What each of these requests was settled against, keyed by request id. Empty when the table is not applied yet. */
export async function loadOffsetsByRequestId(requestIds: string[]): Promise<Map<string, MarketingRequestOffset>> {
  const result = new Map<string, MarketingRequestOffset>();
  if (requestIds.length === 0) return result;

  const supabase = getSupabaseAdmin();
  const offsets = await supabase
    .from("direct_order_marketing_offsets")
    .select("amount, direct_order_id, marketing_request_id, note")
    .in("marketing_request_id", requestIds);
  if (offsets.error) {
    if (isMissingOffsetTableError(offsets.error)) return result;
    throw offsets.error;
  }
  const rows = (offsets.data ?? []) as OffsetRow[];
  if (rows.length === 0) return result;

  const orders = await supabase
    .from("direct_order_requests")
    .select("id, pharmacy_id")
    .in("id", Array.from(new Set(rows.map((row) => row.direct_order_id))));
  if (orders.error) throw orders.error;
  const pharmacyIdByOrder = new Map(
    ((orders.data ?? []) as Array<{ id: string; pharmacy_id: string | null }>).map((row) => [row.id, row.pharmacy_id]),
  );
  const pharmacies = await loadPharmacies(Array.from(pharmacyIdByOrder.values()).filter((id): id is string => Boolean(id)));

  for (const row of rows) {
    const pharmacyId = pharmacyIdByOrder.get(row.direct_order_id);
    result.set(row.marketing_request_id, {
      amount: Number(row.amount),
      directOrderId: row.direct_order_id,
      note: row.note,
      orderLabel: orderLabel(pharmacyId ? pharmacies.get(pharmacyId) : undefined),
    });
  }
  return result;
}

/** Approved direct orders that still owe something — the choices on the settle control. */
export async function listOffsetCandidates(access: AccessContext): Promise<DirectOrderOffsetCandidate[]> {
  await assertPermission(access, "direct_orders", "read");
  assertCanSettle(access);

  const supabase = getSupabaseAdmin();
  const orders = await supabase
    .from("direct_order_requests")
    .select("id, pharmacy_id, sales_month, sales_value, paid_amount, status")
    .eq("status", "approved")
    .order("created_at", { ascending: false })
    .limit(500);
  if (orders.error) throw orders.error;
  const rows = (orders.data ?? []) as OrderRow[];
  if (rows.length === 0) return [];

  const offsets = await supabase
    .from("direct_order_marketing_offsets")
    .select("direct_order_id, amount")
    .in("direct_order_id", rows.map((row) => row.id));
  if (offsets.error && !isMissingOffsetTableError(offsets.error)) throw offsets.error;
  const offsetByOrder = new Map<string, number>();
  for (const row of ((offsets.error ? [] : offsets.data) ?? []) as Array<{ direct_order_id: string; amount: number | string }>) {
    offsetByOrder.set(row.direct_order_id, (offsetByOrder.get(row.direct_order_id) ?? 0) + Number(row.amount));
  }

  const pharmacies = await loadPharmacies(rows.map((row) => row.pharmacy_id).filter((id): id is string => Boolean(id)));

  return rows
    .map((row) => {
      const outstanding = deriveOutstandingAmount({
        offsetTotal: offsetByOrder.get(row.id) ?? 0,
        paidAmount: row.paid_amount == null ? null : Number(row.paid_amount),
        salesValue: Number(row.sales_value),
      });
      return {
        id: row.id,
        label: orderLabel(row.pharmacy_id ? pharmacies.get(row.pharmacy_id) : undefined),
        outstanding,
        salesMonth: row.sales_month,
        salesValue: Number(row.sales_value),
      };
    })
    .filter((candidate) => candidate.outstanding > 0);
}

/**
 * Settle one marketing request against one direct order. All checks and the order's new remainder
 * happen inside the database function under row locks; this adds the audit trail and the order's
 * own timeline entry, both of which say plainly that no cash moved.
 */
export async function recordMarketingRequestOffset(
  access: AccessContext,
  input: { amount: number; directOrderId: string; note?: string | null; requestId: string },
): Promise<{ amount: number; remainingAmount: number }> {
  await assertPermission(access, "direct_orders", "read");
  assertCanSettle(access);

  const actor = hrIdForStorage(access.hrId);
  if (!actor) throw validationError("Sign in again — the action could not be attributed to anyone.");

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("phx_record_direct_order_offset", {
    p_actor_hr_id: actor,
    p_amount: input.amount,
    p_note: input.note ?? null,
    p_order_id: input.directOrderId,
    p_request_id: input.requestId,
  });
  if (error) {
    const message = offsetErrorMessage(error);
    if (message) throw validationError(message);
    if (isMissingOffsetTableError(error) || /phx_record_direct_order_offset/.test(String(error.message ?? ""))) {
      throw validationError("Settling against a direct order is not available yet — its database change has not been applied.");
    }
    throw error;
  }
  const result = data as { amount: number; remainingAfter: number; remainingBefore: number };

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityType: "direct_order_request",
    entityId: input.directOrderId,
    oldValues: { remainingAmount: result.remainingBefore },
    newValues: { remainingAmount: result.remainingAfter, settledMarketingRequestId: input.requestId, settledAmount: result.amount },
    summary: `Marketing request settled against a direct order for ${result.amount} EGP by ${access.hrId ?? "unknown"}; no cash moved.`,
  });
  await supabase.from("direct_order_events").insert({
    request_id: input.directOrderId,
    actor_hr_id: actor,
    event_type: "marketing_offset_recorded",
    message: `${result.amount} EGP settled against a marketing request — no cash moved; ${result.remainingAfter} EGP still outstanding.`,
    metadata: { marketingRequestId: input.requestId, amount: result.amount, remainingAmount: result.remainingAfter },
  });

  pingDirectOrderSheet("marketing_offset_recorded");
  return { amount: Number(result.amount), remainingAmount: Number(result.remainingAfter) };
}

/** Undo a settlement; the debt goes back on the order. */
export async function removeMarketingRequestOffset(
  access: AccessContext,
  input: { requestId: string },
): Promise<{ remainingAmount: number | null }> {
  await assertPermission(access, "direct_orders", "read");
  assertCanSettle(access);

  const actor = hrIdForStorage(access.hrId);
  if (!actor) throw validationError("Sign in again — the action could not be attributed to anyone.");

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("phx_remove_direct_order_offset", {
    p_actor_hr_id: actor,
    p_request_id: input.requestId,
  });
  if (error) {
    const message = offsetErrorMessage(error);
    if (message) throw validationError(message);
    throw error;
  }
  const result = data as { orderId: string; remainingAfter: number | null; removedAmount: number };

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityType: "direct_order_request",
    entityId: result.orderId,
    oldValues: { settledMarketingRequestId: input.requestId, settledAmount: result.removedAmount },
    newValues: { remainingAmount: result.remainingAfter },
    summary: `Settlement of ${result.removedAmount} EGP against a marketing request removed by ${access.hrId ?? "unknown"}.`,
  });
  await supabase.from("direct_order_events").insert({
    request_id: result.orderId,
    actor_hr_id: actor,
    event_type: "marketing_offset_removed",
    message: `Settlement of ${result.removedAmount} EGP against a marketing request removed — the amount is owed again.`,
    metadata: { marketingRequestId: input.requestId, amount: result.removedAmount, remainingAmount: result.remainingAfter },
  });

  pingDirectOrderSheet("marketing_offset_removed");
  return { remainingAmount: result.remainingAfter == null ? null : Number(result.remainingAfter) };
}
