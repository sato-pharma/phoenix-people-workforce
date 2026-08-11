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

/**
 * The workspace's internal views (2026-08-11 IA, second phase of the consolidation).
 *
 * WHAT CHANGED AND WHY:
 *   my-orders + all-orders  →  `orders`, ONE view with a Mine / My team / All-in-scope filter.
 *     Two tabs made the user learn the module's internal scope model to find an order. Which
 *     orders a person may see is a permission question the server already answers; it should not
 *     also be a navigation question they answer.
 *   customers               →  `pharmacy-control`, and ONLY for roles with pharmacy authority.
 *     The old Customers tab mostly explained that pharmacy lookup lives inside New Order — a tab
 *     whose content is an apology for its own existence. Ordinary requesters no longer see it.
 *   admin-tools             →  split by what the user is actually DOING:
 *     `pharmacy-control`  — is this pharmacy real, mapped, trusted, safe to order against?
 *     `reports`           — analytical/monitoring questions.
 *     `controls`          — commercial configuration (caps). Not an order queue, not pharmacy work.
 *     "Admin Tools" named a permission level rather than a task, so everything landed in it.
 */
export type DirectOrderWorkspaceTabKey =
  | "overview"
  | "needs-action"
  | "orders"
  | "pharmacy-control"
  | "reports"
  | "controls";

/** Which slice of the viewer's permitted orders the Orders view is showing. */
export type DirectOrderOrdersFilterKey = "mine" | "team" | "all";

const WORKSPACE_TAB_KEYS: readonly DirectOrderWorkspaceTabKey[] = [
  "overview",
  "needs-action",
  "orders",
  "pharmacy-control",
  "reports",
  "controls",
];

/**
 * The `?view=` values this workspace answered to BEFORE the 2026-08-11 IA change.
 *
 * These are in people's bookmarks, in the sidebar history, in the approved-order email and in
 * `next.config.ts`'s retired-route redirects. A renamed tab must not turn a working link into a
 * silent fallback to Overview — the person clicked "admin tools" and is entitled to land on the
 * view that replaced it.
 */
const LEGACY_TAB_ALIASES: Record<string, DirectOrderWorkspaceTabKey> = {
  "my-orders": "orders",
  "all-orders": "orders",
  // The old Customers tab's only real content was a link to the pharmacy registry, which now
  // lives inside Pharmacy Control.
  customers: "pharmacy-control",
  // Admin Tools split three ways; Pharmacy Control is where most of its traffic was going.
  "admin-tools": "pharmacy-control",
};

/**
 * Resolve a `?view=` value to a real tab, honouring the pre-2026-08-11 names.
 *
 * Falls back to Overview for anything unrecognised — the tab list itself is then filtered against
 * the viewer's capabilities by the component, so this never grants access to a view a role lacks.
 */
export function resolveDirectOrderWorkspaceTab(view: string | null | undefined): DirectOrderWorkspaceTabKey {
  const raw = String(view ?? "").trim();
  if (!raw) return "overview";
  if ((WORKSPACE_TAB_KEYS as readonly string[]).includes(raw)) return raw as DirectOrderWorkspaceTabKey;
  return LEGACY_TAB_ALIASES[raw] ?? "overview";
}

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
    /** True when ANY of the three authority views below is available. */
    canOpenAdminTools: boolean;
    /** Validation desk, held lane, registry, data quality. */
    canOpenPharmacyControl: boolean;
    /** Orders report, rep counters, reconciliation. */
    canOpenReports: boolean;
    /** Bonus/discount caps. */
    canOpenControls: boolean;
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

  // ROLE-SHAPED, not permission-shaped. A view the viewer cannot use is absent, never present and
  // empty — an empty tab still costs a glance and teaches people the module is bigger than their
  // job. Overview / Needs Action / Orders are universal; the rest appear only with the authority
  // they serve.
  const tabs: DirectOrderWorkspaceTabKey[] = ["overview", "needs-action", "orders"];

  // Pharmacy Control is the "is this pharmacy real, mapped, trusted?" domain: the validation desk,
  // the held lane, the registry and the data-quality workflows. An ordinary requester never sees
  // it — all the pharmacy work their job needs is already inside New Order.
  const canOpenPharmacyControl = canDecideCustomerValidations || scope === "all";
  if (canOpenPharmacyControl) tabs.push("pharmacy-control");

  // Reports & Monitoring: the report, per-rep behaviour counters, reconciliation. Anyone whose
  // scope reaches past their own orders has a monitoring question worth answering.
  const canOpenReports = canSeeAllOrders || canAssignFinanceMonth;
  if (canOpenReports) tabs.push("reports");

  // Commercial Controls: bonus/discount caps. Deliberately NOT inside Pharmacy Control — caps are
  // commercial configuration, not pharmacy work, and mixing them was part of what made a single
  // "Admin Tools" bucket unreadable.
  const canOpenControls = scope === "all";
  if (canOpenControls) tabs.push("controls");

  // Retained for the component's existing capability checks and for the admin-desk link list.
  const canOpenAdminTools = canOpenPharmacyControl || canOpenReports || canOpenControls;

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
      canOpenPharmacyControl,
      canOpenReports,
      canOpenControls,
    },
    basePath: options.basePath,
  };
}
