import type { AccessContext } from "@/lib/auth/permissions";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import {
  buildDirectOrderNeedsAction,
  buildDirectOrderWorkspaceSummary,
  type DirectOrderNeedsActionGroup,
  type DirectOrderQueueRow,
  type DirectOrderWorkspaceSummary,
} from "@/lib/direct-orders/needs-action";
import {
  canDecideDirectOrderPharmacyValidations,
  listDirectOrderPharmacyValidations,
} from "@/lib/direct-orders/pharmacy-validation";
import {
  canSetDirectOrderSalesMonth,
  getDirectOrderReport,
  getDirectOrderWorkspaceData,
  listMyDirectOrders,
  resolveDirectOrderReportScope,
} from "@/lib/direct-orders/service";
import { isDirectOrderRequesterRole } from "@/lib/direct-orders/types";
import type { DirectOrderApprovalListItem, DirectOrderReportScope } from "@/lib/direct-orders/types";

// ─────────────────────────────────────────────────────────────────────────────
// The one server read behind the consolidated Direct Orders workspace.
//
// It COMPOSES the existing services and adds no rules of its own. Every list it
// returns was produced by the function that already owned that question, with its
// own `assertPermission` and its own scope tiering intact:
//
//   getDirectOrderWorkspaceData  -> awaiting / held / decision history
//   listMyDirectOrders           -> the caller's own orders
//   getDirectOrderReport         -> the tiered "all orders" view
//   listDirectOrderPharmacyValidations -> the Super-Admin validation queue
//
// Nothing here queries Supabase directly, precisely so that no visibility rule
// gets a second definition. The one thing this file decides is WHAT NOT TO LOAD:
// each of the four reads is skipped for a viewer who cannot use its result, which
// is what keeps a consolidated screen from becoming the "one enormous page that
// loads every dataset" the brief warns about.
// ─────────────────────────────────────────────────────────────────────────────

export type DirectOrderWorkspaceTabKey =
  | "overview"
  | "needs-action"
  | "my-orders"
  | "all-orders"
  | "customers"
  | "admin-tools";

export type DirectOrderWorkspaceView = {
  summary: DirectOrderWorkspaceSummary;
  needsAction: DirectOrderNeedsActionGroup[];
  myOrders: DirectOrderApprovalListItem[];
  /** Everything the viewer may see, tiered. Empty for a viewer whose scope is "own" — they use myOrders. */
  allOrders: DirectOrderQueueRow[];
  scope: DirectOrderReportScope;
  /** Which tabs to render. A tab the viewer cannot use is never shown — not shown-and-empty. */
  tabs: DirectOrderWorkspaceTabKey[];
  capabilities: {
    canCreate: boolean;
    canSeeAllOrders: boolean;
    canAssignFinanceMonth: boolean;
    canDecideCustomerValidations: boolean;
    canOpenAdminTools: boolean;
  };
  /** Route prefix for this shell, so every link the workspace builds stays inside it. */
  basePath: string;
};

/** YYYY-MM in Africa/Cairo — never the server clock (owner rule: Cairo time, always). */
export function currentCairoSalesMonth(now: Date = new Date()): string {
  return currentCairoDateOnlyIso(now).slice(0, 7);
}

/**
 * `DirectOrderReportRow` carries no `bonusOverCap` — that flag is computed by the
 * approvals path, not the report path. Defaulting it to false here is deliberate
 * and safe: the flag only ever ADDS a warning chip, so a false reads as "nothing
 * flagged", never as "checked and clear". The chip is still shown on the row's own
 * order page, which is where the decision is actually taken.
 */
function reportRowToQueueRow(row: {
  id: string;
  requesterName: string;
  productName: string;
  qty: number;
  pharmacyName: string;
  pharmacyCode: string;
  areaName: string;
  regionName: string;
  salesValue: number;
  createdAt: string;
  status: string;
  salesMonth: string | null;
}): DirectOrderQueueRow {
  return {
    id: row.id,
    requesterName: row.requesterName,
    productName: row.productName,
    qty: row.qty,
    pharmacyName: row.pharmacyName,
    pharmacyCode: row.pharmacyCode,
    areaName: row.areaName,
    regionName: row.regionName,
    salesValue: row.salesValue,
    createdAt: row.createdAt,
    status: row.status,
    salesMonth: row.salesMonth,
    bonusOverCap: false,
  };
}

export async function loadDirectOrderWorkspaceView(
  access: AccessContext,
  options: { basePath: string; now?: Date },
): Promise<DirectOrderWorkspaceView> {
  const scope = resolveDirectOrderReportScope(access);
  const canAssignFinanceMonth = canSetDirectOrderSalesMonth(access);
  const canDecideCustomerValidations = canDecideDirectOrderPharmacyValidations(access);
  const canCreate = isDirectOrderRequesterRole(access.role) || access.role === "Super Admin";
  // "own" scope means the report would return exactly what listMyDirectOrders already
  // returned, so the All Orders tab has nothing to add and is not offered. This is the
  // difference between a role-shaped UI and a full one with most of it greyed out.
  const canSeeAllOrders = scope !== "own";

  // The four reads run together, and the three optional ones resolve to a constant
  // for a viewer who cannot use them — so a District Manager pays for exactly one
  // query set, not four.
  const [workspace, myOrders, reportRows, pendingValidations] = await Promise.all([
    getDirectOrderWorkspaceData(access),
    listMyDirectOrders(access),
    canSeeAllOrders || canAssignFinanceMonth
      ? getDirectOrderReport(access)
      : Promise.resolve([]),
    canDecideCustomerValidations
      ? listDirectOrderPharmacyValidations(access, { status: "pending" })
      : Promise.resolve([]),
  ]);

  const allOrders = reportRows.map(reportRowToQueueRow);

  // The Finance queue is derived from the SAME report rows already loaded above
  // rather than a second query — and only for the person who can actually book a
  // month, because a queue nobody can clear is how people learn to ignore queues
  // (the reasoning getDirectOrderUnbookedBadge already applies to the sidebar badge).
  const awaitingFinanceMonth = canAssignFinanceMonth
    ? allOrders.filter((row) => row.status === "approved" && !row.salesMonth)
    : [];

  const needsAction = buildDirectOrderNeedsAction({
    awaitingMyApproval: workspace.awaiting,
    myOrders,
    awaitingFinanceMonth,
    pendingCustomerValidations: pendingValidations.length,
    basePath: options.basePath,
  });

  const summary = buildDirectOrderWorkspaceSummary({
    needsAction,
    // A viewer with a wider scope reads the wider set; everyone else reads their own.
    // Same numbers either way for an "own"-scope viewer, one query fewer.
    scopedOrders: canSeeAllOrders ? allOrders : myOrders,
    currentSalesMonth: currentCairoSalesMonth(options.now),
  });

  const tabs: DirectOrderWorkspaceTabKey[] = ["overview", "needs-action", "my-orders"];
  if (canSeeAllOrders) tabs.push("all-orders");
  tabs.push("customers");
  const canOpenAdminTools = canDecideCustomerValidations || canAssignFinanceMonth || scope === "all";
  if (canOpenAdminTools) tabs.push("admin-tools");

  return {
    summary,
    needsAction,
    myOrders,
    allOrders,
    scope,
    tabs,
    capabilities: {
      canCreate,
      canSeeAllOrders,
      canAssignFinanceMonth,
      canDecideCustomerValidations,
      canOpenAdminTools,
    },
    basePath: options.basePath,
  };
}
