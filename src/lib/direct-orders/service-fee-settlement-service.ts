/**
 * The Administrator's one-click service-fee settlement.
 *
 * THE SITUATION (Zamzam Hospital, October 2026). A hospital paid a direct order net of a sum it owes
 * its own doctor on the company's behalf. The owner — the only Super Admin — decided that this is
 * recorded by him alone, with no employee handling it: a marketing request is raised under the
 * order's own requester, runs the whole approval chain as DECIDED BY THE ADMINISTRATOR (the audit
 * says so on every rung, never another person's name), and is settled against the order's debt.
 * No cash moves, and nothing is sent to anyone.
 *
 * Authority is the Administrator's only (canSettleServiceFeeAsAdministrator) — not Finance, because
 * Finance settles a request somebody else raised and the chain approved, whereas this writes the
 * chain itself. Every rule is repeated under row locks by `phx_admin_settle_service_fee`; the checks
 * here exist to give the screen its words and to refuse before a database round trip.
 */

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import type { AccessContext } from "@/lib/auth/permissions";
import { assertPermission } from "@/lib/auth/permissions";
import { canSettleServiceFeeAsAdministrator } from "@/lib/direct-orders/finance-authority";
import {
  deriveOutstandingAmount,
  isMissingOffsetTableError,
  offsetErrorMessage,
  validateServiceFeeSettlement,
} from "@/lib/direct-orders/offset-rules";
import { loadOffsetTotalForOrder } from "@/lib/direct-orders/marketing-offset-service";
import { pingDirectOrderSheet } from "@/lib/direct-orders/sheet-webhook";
import { forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { hrIdForStorage } from "@/lib/hr-id";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type ServiceFeeSettlementInput = {
  amount: number;
  beneficiaryName: string;
  directOrderId: string;
  note?: string | null;
  requestTypeCode: string;
};

export type ServiceFeeSettlementResult = {
  amount: number;
  remainingAmount: number;
  requestCode: string;
};

type OrderRow = {
  id: string;
  paid_amount: number | string | null;
  requester_hr_id: string | null;
  sales_value: number | string | null;
  status: string | null;
};

export async function settleServiceFeeAsAdministrator(
  access: AccessContext,
  input: ServiceFeeSettlementInput,
): Promise<ServiceFeeSettlementResult> {
  await assertPermission(access, "direct_orders", "read");
  if (!canSettleServiceFeeAsAdministrator(access)) {
    throw forbiddenError("Forbidden: only the Administrator can record a service fee against a direct order in one step.");
  }
  const actor = hrIdForStorage(access.hrId);
  if (!actor) throw validationError("Sign in again — the action could not be attributed to anyone.");

  const supabase = getSupabaseAdmin();
  const orderResult = await supabase
    .from("direct_order_requests")
    .select("id, paid_amount, requester_hr_id, sales_value, status")
    .eq("id", input.directOrderId)
    .maybeSingle();
  if (orderResult.error) throw orderResult.error;
  const order = orderResult.data as OrderRow | null;
  if (!order) throw notFoundError("That direct order was not found.");
  if (!order.requester_hr_id) throw validationError("This order has no requester to record the request under.");

  const outstanding = deriveOutstandingAmount({
    offsetTotal: await loadOffsetTotalForOrder(order.id),
    paidAmount: order.paid_amount == null ? null : Number(order.paid_amount),
    salesValue: Number(order.sales_value),
  });
  const verdict = validateServiceFeeSettlement({
    amount: input.amount,
    beneficiaryName: input.beneficiaryName,
    note: input.note,
    orderStatus: order.status ?? "",
    outstanding,
    requestTypeCode: input.requestTypeCode,
  });
  if (!verdict.ok) throw validationError(verdict.message);

  const { data, error } = await supabase.rpc("phx_admin_settle_service_fee", {
    p_admin_hr_id: actor,
    p_amount: verdict.amount,
    p_beneficiary_name: input.beneficiaryName,
    p_note: input.note ?? null,
    p_order_id: order.id,
    p_request_type_code: input.requestTypeCode,
    p_requester_hr_id: order.requester_hr_id,
  });
  if (error) {
    const message = offsetErrorMessage(error);
    if (message) throw validationError(message);
    if (isMissingOffsetTableError(error) || /phx_admin_settle_service_fee/.test(String(error.message ?? ""))) {
      throw validationError("Recording a service fee is not available yet — its database change has not been applied.");
    }
    throw error;
  }
  const result = data as {
    amount: number;
    remainingAfter: number;
    remainingBefore: number;
    requestCode: string;
    requestId: string;
  };

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityType: "direct_order_request",
    entityId: order.id,
    oldValues: { remainingAmount: result.remainingBefore },
    newValues: {
      remainingAmount: result.remainingAfter,
      serviceFeeAmount: result.amount,
      serviceFeeMarketingRequestId: result.requestId,
    },
    summary: `Service fee of ${result.amount} EGP recorded by the Administrator (${access.hrId ?? "unknown"}) as marketing request ${result.requestCode}, raised and executed in one step and settled against this order; no cash moved.`,
  });
  await supabase.from("direct_order_events").insert({
    request_id: order.id,
    actor_hr_id: actor,
    event_type: "marketing_service_fee_recorded",
    message: `${result.amount} EGP recorded by the Administrator as ${result.requestCode} and settled against this order — no cash moved; ${result.remainingAfter} EGP still outstanding.`,
    metadata: {
      amount: result.amount,
      marketingRequestId: result.requestId,
      remainingAmount: result.remainingAfter,
      requestCode: result.requestCode,
    },
  });

  pingDirectOrderSheet("marketing_service_fee_recorded");
  return {
    amount: Number(result.amount),
    remainingAmount: Number(result.remainingAfter),
    requestCode: result.requestCode,
  };
}
