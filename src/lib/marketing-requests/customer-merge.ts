import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { assertRealSessionForDecision } from "@/lib/auth/preview-session-guard";
import type { AccessContext } from "@/lib/auth/permissions";
import { bumpCustomer360Cache } from "@/lib/cache/namespaces";
import { hrIdForStorage } from "@/lib/hr-id";
import { forbiddenError, validationError } from "@/lib/http/api-errors";
import type { MarketingCustomerMergeOption } from "@/lib/marketing-requests/customer-merge-rules";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * Merge one marketing customer into another (owner, 2026-11-03). Every rule is in the database function
 * `phx_merge_marketing_customers`, because this moves six tables and has to land whole or not at all. Its
 * refusals raise P0001 with a sentence a person can read, which is what reaches the screen here.
 *
 * Super Admin only. The Customer Database page also admits the SFE Manager, so the panel hides on the 403.
 */

export type MarketingCustomerMergeInput = {
  carryEvidence: boolean;
  reason: string;
  retiredId: string;
  survivorId: string;
};

export type MarketingCustomerMergeResult = {
  contactsMoved: number;
  evidenceCarried: boolean;
  linksLeftOnRetired: number;
  linksMoved: number;
  linksReactivated: number;
  requestsMoved: number;
  transfersMoved: number;
  validationCarried: string | null;
  venuesMoved: number;
};

type OptionRow = {
  area_name: string | null;
  contacts: number | string;
  customer_code: string;
  customer_type: string;
  display_name: string;
  evidence_complete: boolean;
  evidence_status: string;
  id: string;
  line_name: string | null;
  links: number | string;
  live_transfer: boolean;
  normalized_name: string;
  owner_name: string | null;
  requests: number | string;
  validation_status: string;
};

function assertCustomerMergeAccess(access: AccessContext): void {
  if (access.role !== "Super Admin") throw forbiddenError("Forbidden: merging marketing customers is Super Admin only.");
}

export async function listMarketingCustomerMergeOptions(access: AccessContext): Promise<MarketingCustomerMergeOption[]> {
  assertCustomerMergeAccess(access);
  const { data, error } = await getSupabaseAdmin().rpc("phx_marketing_customer_merge_options");
  if (error) throw error;
  return ((data ?? []) as OptionRow[]).map((row) => ({
    areaName: row.area_name,
    code: row.customer_code,
    contacts: Number(row.contacts),
    customerType: row.customer_type,
    evidenceComplete: row.evidence_complete,
    evidenceStatus: row.evidence_status,
    id: row.id,
    lineName: row.line_name,
    links: Number(row.links),
    liveTransfer: row.live_transfer,
    name: row.display_name,
    normalizedName: row.normalized_name,
    ownerName: row.owner_name,
    requests: Number(row.requests),
    validationStatus: row.validation_status,
  }));
}

export async function mergeMarketingCustomers(
  access: AccessContext,
  input: MarketingCustomerMergeInput,
): Promise<MarketingCustomerMergeResult> {
  assertCustomerMergeAccess(access);
  assertRealSessionForDecision(access, "merge two customers");

  const survivorId = String(input.survivorId ?? "").trim();
  const retiredId = String(input.retiredId ?? "").trim();
  const reason = String(input.reason ?? "").trim();
  if (!survivorId || !retiredId) throw validationError("Both the customer that stays and the customer to retire must be named.");
  if (!reason) throw validationError("A merge needs a written reason. It is the only record of why two rows were judged one customer.");

  const { data, error } = await getSupabaseAdmin().rpc("phx_merge_marketing_customers", {
    p_actor_hr_id: hrIdForStorage(access.hrId),
    p_carry_evidence: input.carryEvidence === true,
    p_reason: reason,
    p_retired_id: retiredId,
    p_survivor_id: survivorId,
  });
  if (error) {
    if (error.code === "P0001") throw validationError(error.message);
    throw error;
  }
  const result = data as MarketingCustomerMergeResult;

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityId: retiredId,
    entityType: "marketing_customer",
    newValues: { active: false, mergedIntoCustomerId: survivorId, ...result },
    oldValues: { active: true, mergedIntoCustomerId: null },
    summary:
      `Marketing customer merged into ${survivorId}. Moved ${result.requestsMoved} request(s), ${result.contactsMoved} contact(s), `
      + `${result.linksMoved} link(s) and ${result.transfersMoved} transfer(s). Reason: ${reason}`,
  });
  bumpCustomer360Cache("marketing customer merged");
  return result;
}
