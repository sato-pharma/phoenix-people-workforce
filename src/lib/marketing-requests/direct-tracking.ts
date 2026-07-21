import type { AccessContext } from "@/lib/auth/permissions";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * Phase D — Super-Admin-only control for whether a marketing campaign's ROI should
 * also credit the sales from approved Direct Order Requests at its own target
 * pharmacies + products. This is an ROI-attribution setting, NOT request content, so
 * it deliberately sits OUTSIDE the read-only-after-submit lockdown: only a Super Admin
 * may change it, and it never lets an approver edit what was requested.
 */

export type MarketingDirectTrackingState = {
  trackDirectSales: boolean;
  /** True only for a Super Admin — the client shows an interactive toggle iff this is true. */
  canManage: boolean;
};

function isSuperAdmin(access: AccessContext): boolean {
  return access.role === "Super Admin" || access.scope === "system";
}

export async function getMarketingRequestDirectTracking(
  access: AccessContext,
  requestId: string,
): Promise<MarketingDirectTrackingState> {
  const cleanId = String(requestId ?? "").trim();
  if (!cleanId) throw new Error("Marketing request id is required.");
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("marketing_requests")
    .select("track_direct_sales")
    .eq("id", cleanId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("marketing_request_not_found");
  return {
    trackDirectSales: Boolean((data as { track_direct_sales?: boolean | null }).track_direct_sales),
    canManage: isSuperAdmin(access),
  };
}

export async function setMarketingRequestTrackDirectSales(
  access: AccessContext,
  requestId: string,
  enabled: boolean,
): Promise<MarketingDirectTrackingState> {
  if (!isSuperAdmin(access)) {
    throw new Error("Forbidden: only a Super Admin can change direct-sales tracking for a campaign.");
  }
  const cleanId = String(requestId ?? "").trim();
  if (!cleanId) throw new Error("Marketing request id is required.");
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("marketing_requests")
    .update({ track_direct_sales: enabled, updated_at: new Date().toISOString() })
    .eq("id", cleanId)
    .select("id, track_direct_sales")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("marketing_request_not_found");

  // Re-materialize the ROI facts so the coverage dashboards reflect the change at
  // once (the on-demand ROI report already recomputes live). Best-effort: a failure
  // here must not lose the persisted flag change.
  const { error: refreshError } = await supabase.rpc("phx_refresh_marketing_roi_facts", { p_batch_id: null });
  if (refreshError) {
    logError("Marketing ROI facts refresh after direct-tracking toggle failed", {
      labels: { event: "marketing_direct_tracking_roi_refresh_failed", requestId: cleanId },
      error: refreshError,
    });
  }

  return {
    trackDirectSales: Boolean((data as { track_direct_sales?: boolean | null }).track_direct_sales),
    canManage: true,
  };
}
