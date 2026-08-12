import type { AccessContext } from "@/lib/auth/permissions";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import {
  buildDirectOrderNeedsAction,
  countDirectOrderNeedsAction,
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
  listDirectOrderAwaitingFinanceMonth,
  countDirectOrderWorkspaceTotals,
  listDirectOrderOperationalPage,
  listMyDirectOrders,
  resolveDirectOrderReportScope,
} from "@/lib/direct-orders/service";
import type {
  DirectOrderOperationalFilters,
  DirectOrderOperationalPage,
} from "@/lib/direct-orders/operational-query";
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
/**
 * Where an order detail's Back link should return the reader.
 *
 * The detail pages hardcoded the workspace ROOT, so someone who opened an order from
 * `?view=orders&group=in-progress&page=3&q=salam` came back to an unfiltered Overview on page 1 and
 * had to rebuild the list they were working through. That is the single most repeated action in the
 * module — an approver works down a queue one order at a time.
 *
 * SECURITY: this value comes from the query string, so it is an open-redirect vector if trusted.
 * Three rules, all of which must hold:
 *
 *   1. It must be RELATIVE — a single leading "/" and no scheme.
 *   2. It must not begin "//", which a browser reads as a protocol-relative ABSOLUTE url
 *      (`//evil.example` is a different host, not a path).
 *   3. It must sit inside the caller's own basePath, so a link from the portal cannot bounce a
 *      reader into the admin shell or anywhere else in the app.
 *
 * Anything else falls back to the base path. Falling back costs the reader their filters; trusting
 * it costs them rather more, and a Back button is not worth an open redirect.
 */
export function resolveDirectOrderReturnHref(
  from: string | null | undefined,
  basePath: string,
): string {
  const candidate = String(from ?? "").trim();
  if (!candidate) return basePath;
  if (!candidate.startsWith("/") || candidate.startsWith("//")) return basePath;
  // Backslashes are read as forward slashes by some browsers, so "/\evil.example" would slip
  // past the "//" check above. Control characters and spaces do the same once a browser strips
  // them, so the whole range below \x20 is refused rather than enumerated.
  if (/[\\\x00-\x20]/.test(candidate)) return basePath;
  // EXACTLY the workspace, not merely something underneath it: `${basePath}/<id>` is another
  // order's detail, and Back must never quietly mean sideways.
  const path = candidate.split(/[?#]/)[0];
  if (path !== basePath) return basePath;
  return candidate;
}

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
  /**
   * ONE PAGE of the Orders view, scoped/filtered/paginated in the database. Null for every view
   * other than `orders` — this is the read that view uses, and no other.
   *
   * This is what replaced `allOrders` for the Orders list. `allOrders` below still exists, but only
   * because Overview's counters and the Needs Action Finance queue are still derived from it; once
   * those move to their own aggregate reads it can go, and with it the last full-table read on a
   * routine screen.
   */
  orders: DirectOrderOperationalPage<DirectOrderQueueRow> | null;
  /**
   * Everything the viewer may see, tiered. Empty for a viewer whose scope is "own" — they use
   * myOrders.
   *
   * NO LONGER FEEDS THE ORDERS LIST. Retained ONLY for the Overview summary and the Finance queue,
   * which still count across the whole permitted set. Do not reintroduce it as a list source — that
   * is the full-table read this work exists to remove.
   */
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

/**
 * Which views actually need the full report row set.
 *
 * `getDirectOrderReport` is the expensive read in this module — it selects every request in the
 * viewer's scope and decorates it. Before this list it ran on EVERY workspace open regardless of
 * which view the user asked for, so opening Overview paid for the All-Orders dataset.
 *
 * BOTH ORIGINAL REASONS ARE NOW GONE (2026-08-12). The summary counters are
 * `countDirectOrderWorkspaceTotals` (four COUNT queries) and the Finance queue is
 * `listDirectOrderAwaitingFinanceMonth` (its own focused read). Nothing in this loader consumes
 * `allOrders` any more.
 *
 * SO WHY ARE `overview` AND `needs-action` STILL HERE? Because the workspace switches tabs
 * CLIENT-SIDE. A viewer who loads `?view=overview` and then clicks Orders gets a component whose
 * `ordersPage` prop is null — it was fetched for overview, not for orders — and the list falls back
 * to `allOrders`. Empty that, and clicking the Orders tab shows a blank list to anyone who did not
 * arrive at `?view=orders` directly.
 *
 * The remaining full-table read is therefore blocked on NAVIGATION, not on queries: once tab
 * changes become URL navigations (the URL-state work), each view fetches its own data on arrival,
 * `allOrders` has no readers left, and this list can go to empty along with `getDirectOrderReport`
 * disappearing from this file entirely.
 *
 * Do not empty this list before that lands. It would trade a slow page for a blank one.
 */
const VIEWS_NEEDING_FULL_REPORT: readonly DirectOrderWorkspaceTabKey[] = [
  "overview",
  "needs-action",
  // `orders` was HERE until 2026-08-12. It is gone because the Orders view now reads
  // `listDirectOrderOperationalPage` — scoped, filtered and paginated in the database, decorating
  // one page rather than the whole population. Opening Orders no longer touches the report at all.
  //
  // Overview and Needs Action remain for the correctness reasons above, and are the last two.
  "reports",
];

export async function loadDirectOrderWorkspaceView(
  access: AccessContext,
  options: {
    basePath: string;
    now?: Date;
    /**
     * The view being rendered. Data the view cannot show is not fetched. Defaults to `overview`
     * so an omitted value is the conservative case (loads the most), never the silently-empty one.
     */
    view?: DirectOrderWorkspaceTabKey;
    /** Orders view only: which page, and the filters to apply IN THE QUERY. */
    ordersPage?: number | null;
    ordersPageSize?: number | null;
    ordersFilters?: DirectOrderOperationalFilters | null;
  },
): Promise<DirectOrderWorkspaceView> {
  const scope = resolveDirectOrderReportScope(access);
  const canAssignFinanceMonth = canSetDirectOrderSalesMonth(access);
  const canDecideCustomerValidations = canDecideDirectOrderPharmacyValidations(access);
  const canCreate = isDirectOrderRequesterRole(access.role) || access.role === "Super Admin";
  // "own" scope means the report would return exactly what listMyDirectOrders already
  // returned, so the All Orders tab has nothing to add and is not offered. This is the
  // difference between a role-shaped UI and a full one with most of it greyed out.
  const canSeeAllOrders = scope !== "own";

  // The four reads run together, and each optional one resolves to a constant for a viewer who
  // cannot use it — so a District Manager pays for exactly one query set, not four.
  //
  // VIEW-AWARE (2026-08-11). Capability was never the only question: a viewer who CAN see every
  // order still does not need every order to render Needs Action or Pharmacy Control. Each read is
  // now gated on `canUse && viewNeedsIt`, so opening the workspace on a view that shows none of
  // this costs nothing for it.
  const view = options.view ?? "overview";
  const needsFullReport =
    (canSeeAllOrders || canAssignFinanceMonth) && VIEWS_NEEDING_FULL_REPORT.includes(view);
  // Pharmacy Control renders the validation queue; Overview and Needs Action need only its COUNT,
  // which the list already gives us for free once loaded. No other view mentions it.
  const needsValidations =
    canDecideCustomerValidations &&
    (view === "overview" || view === "needs-action" || view === "pharmacy-control");

  // The Orders view's page is fetched ONLY for that view, and it is the only read that view needs:
  // the query scopes, filters and paginates in the database and decorates just the returned page.
  const needsOrdersPage = view === "orders";

  const [workspace, myOrders, reportRows, pendingValidations, ordersPage] = await Promise.all([
    getDirectOrderWorkspaceData(access),
    listMyDirectOrders(access),
    needsFullReport ? getDirectOrderReport(access) : Promise.resolve([]),
    needsValidations
      ? listDirectOrderPharmacyValidations(access, { status: "pending" })
      : Promise.resolve([]),
    needsOrdersPage
      ? listDirectOrderOperationalPage(access, {
          page: options.ordersPage ?? null,
          pageSize: options.ordersPageSize ?? null,
          filters: options.ordersFilters ?? null,
        })
      : Promise.resolve(null),
  ]);

  const allOrders = reportRows.map(reportRowToQueueRow);

  // The Finance queue is its OWN focused read (2026-08-12) — `status = 'approved' AND sales_month
  // IS NULL`, straight from the database — rather than a filter over the whole report. It used to
  // be derived from `allOrders`, which meant opening the inbox loaded the entire Direct Orders
  // population to surface a handful of rows.
  //
  // The capability gate lives INSIDE listDirectOrderAwaitingFinanceMonth rather than out here, so
  // it cannot be forgotten by a future caller: a queue nobody can clear is how people learn to
  // ignore queues, and that rule now sits with the query instead of beside it.
  const awaitingFinanceMonth = await listDirectOrderAwaitingFinanceMonth(access);

  const needsAction = buildDirectOrderNeedsAction({
    awaitingMyApproval: workspace.awaiting,
    myOrders,
    awaitingFinanceMonth,
    pendingCustomerValidations: pendingValidations.length,
    basePath: options.basePath,
  });

  // Overview's three order counters now come from COUNT queries rather than from walking every row
  // the viewer can see (2026-08-12). `needsMyAction` still comes from the already-built Needs Action
  // groups — it is a count of things already in memory, so it costs nothing and must not drift from
  // the inbox it summarises.
  //
  // Only fetched for the view that renders them. Every other view got these four numbers for free
  // from a full-table read it was doing anyway; now nobody does that read, so nobody gets them by
  // accident either.
  const totals = view === "overview"
    ? await countDirectOrderWorkspaceTotals(access, currentCairoSalesMonth(options.now))
    : { inProgress: 0, returned: 0, completedThisMonth: 0 };
  const summary: DirectOrderWorkspaceSummary = {
    needsMyAction: countDirectOrderNeedsAction(needsAction),
    ...totals,
  };

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
    orders: ordersPage,
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
