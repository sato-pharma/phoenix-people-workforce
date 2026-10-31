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
  canDecideDirectOrderInvoiceValidations,
  listDirectOrderPharmacyValidations,
} from "@/lib/direct-orders/pharmacy-validation";
import {
  canSetDirectOrderSalesMonth,
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
  DirectOrderOrdersScopeFilter,
} from "@/lib/direct-orders/operational-query";
import { resolveEffectiveOrdersScope } from "@/lib/direct-orders/orders-scope";
import { isDirectOrderRequesterRole } from "@/lib/direct-orders/types";
import type { DirectOrderApprovalListItem, DirectOrderReportScope } from "@/lib/direct-orders/types";

// ─────────────────────────────────────────────────────────────────────────────
// The one server read behind the consolidated Direct Orders workspace.
//
// It COMPOSES the existing services and adds no rules of its own. Every list it
// returns was produced by the function that already owned that question, with its
// own `assertPermission` and its own scope tiering intact:
//
//   getDirectOrderWorkspaceData        -> awaiting (asked for alone: held and decision
//                                         history are drawn nowhere here)
//   listMyDirectOrders                 -> the caller's own orders
//   listDirectOrderOperationalPage     -> ONE page of the Orders list, scoped and
//                                         filtered in the database
//   countDirectOrderWorkspaceTotals    -> the Overview counters, as COUNTs
//   listDirectOrderAwaitingFinanceMonth-> the Finance queue
//   listDirectOrderPharmacyValidations -> the Super-Admin validation queue
//
// `getDirectOrderReport` used to be on that list and is deliberately absent now —
// see the note above VIEWS_NEEDING_FULL_REPORT's grave, further down. The report
// still backs the report PAGE, which legitimately wants everything to export it.
//
// Nothing here queries Supabase directly, precisely so that no visibility rule
// gets a second definition. The one thing this file decides is WHAT NOT TO LOAD:
// each read is skipped for a viewer who cannot use its result, which
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

/**
 * Which tabs this viewer gets. PURE CAPABILITY — no queries, so the desk shell can render the strip
 * without paying for the workspace's data.
 *
 * ROLE-SHAPED, not permission-shaped. A view the viewer cannot use is absent, never present and
 * empty — an empty tab still costs a glance and teaches people the module is bigger than their job.
 * Overview / Needs Action / Orders are universal; the rest appear only with the authority they
 * serve.
 *
 * Extracted from `loadDirectOrderWorkspaceView` when the desks moved under a shared shell
 * (2026-08-12). The layout above every desk needs this answer and nothing else the loader fetches;
 * calling the loader there would have run four counts and a needs-action build to draw six buttons.
 * The loader now calls this too, so the strip on a desk and the strip in the workspace cannot
 * disagree about which tabs exist.
 */
export function resolveDirectOrderWorkspaceTabs(access: AccessContext): DirectOrderWorkspaceTabKey[] {
  const scope = resolveDirectOrderReportScope(access);
  const canAssignFinanceMonth = canSetDirectOrderSalesMonth(access);
  const canDecideCustomerValidations = canDecideDirectOrderInvoiceValidations(access);
  // "own" scope means the report would return exactly what listMyDirectOrders already returned, so
  // the wider views have nothing to add.
  const canSeeAllOrders = scope !== "own";

  const tabs: DirectOrderWorkspaceTabKey[] = ["overview", "needs-action", "orders"];

  // Pharmacy Control is the "is this pharmacy real, mapped, trusted?" domain: the validation desk,
  // the held lane, the registry and the data-quality workflows. An ordinary requester never sees
  // it — all the pharmacy work their job needs is already inside New Order.
  if (canDecideCustomerValidations || scope === "all") tabs.push("pharmacy-control");

  // Reports & Monitoring: the report, per-rep behaviour counters, reconciliation, and the approval
  // exceptions desk. Anyone whose scope reaches past their own orders has a monitoring question.
  if (canSeeAllOrders || canAssignFinanceMonth) tabs.push("reports");

  // Commercial Controls: bonus/discount caps. Deliberately NOT inside Pharmacy Control — caps are
  // commercial configuration, not pharmacy work, and mixing them was part of what made a single
  // "Admin Tools" bucket unreadable.
  if (scope === "all") tabs.push("controls");

  return tabs;
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
   * The slice the Orders list is showing — the viewer's own orders, or the whole scope they may
   * see. Resolved here because the default depends on whether they have raised anything
   * (`resolveEffectiveOrdersScope`); the client reads an explicit `?scope=` itself and falls back
   * to this.
   */
  ordersScope: DirectOrderOrdersScopeFilter;
  /**
   * Overview's "Recent orders": the viewer's own latest five, or — for a viewer with a wider scope
   * who has raised none — the latest five in their scope, so the card is not "You have not raised
   * a direct order yet" above 91 orders they can see. Empty for every other view.
   */
  recentOrders: DirectOrderQueueRow[];
  recentOrdersScope: DirectOrderOrdersScopeFilter;
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

// reportRowToQueueRow was removed on 2026-08-12 along with `allOrders`, its only caller. It
// adapted a DirectOrderReportRow into a queue row for the Orders list; the list now reads
// listDirectOrderOperationalPage, which returns queue rows directly and never loads the report.

// getDirectOrderReport IS GONE FROM THIS FILE (2026-08-12).
//
// It selected every request in the viewer's scope, with no limit, and decorated all of it — on a
// routine screen. Three reads replaced it, each fetching only what its view shows: the Orders
// list uses listDirectOrderOperationalPage (scoped, filtered and paginated in the database), the
// Overview counters use countDirectOrderWorkspaceTotals (four COUNTs), and the Finance queue uses
// listDirectOrderAwaitingFinanceMonth.
//
// The last thing holding it here was `allOrders`, the Orders list's fallback, kept alive only
// because tab switching was CLIENT-side: someone who loaded ?view=overview and clicked Orders got
// a component whose ordersPage prop was null. Once tabs became real URL navigations each view
// fetches its own data on arrival, that fallback became unreachable, and both it and this read
// could go. The report itself still exists for the report PAGE, which legitimately wants
// everything in order to export it.

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
  const canDecideCustomerValidations = canDecideDirectOrderInvoiceValidations(access);
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
  // Pharmacy Control renders the validation queue; Overview and Needs Action need only its COUNT,
  // which the list already gives us for free once loaded. No other view mentions it.
  //
  // EVERY view, not only those three: the "Needs my action" tile renders above every tab, and its
  // number includes this count. Skipping the read on Orders printed a smaller number there than on
  // Overview for the same person.
  const needsValidations = canDecideCustomerValidations;

  // The Orders view's page is fetched ONLY for that view, and it is the only read that view needs:
  // the query scopes, filters and paginates in the database and decorates just the returned page.
  const needsOrdersPage = view === "orders";

  // What the Orders list and Overview's "Recent orders" show when the URL names no scope depends on
  // whether the viewer has raised anything, so the Orders page waits on `myOrders` — only when the
  // URL left the choice open; an explicit `?scope=` needs nothing from it.
  const requestedScope = options.ordersFilters?.scopeFilter ?? null;
  const myOrdersRead = listMyDirectOrders(access);
  const scopeRead = requestedScope
    ? Promise.resolve(
        resolveEffectiveOrdersScope({ requested: requestedScope, canSeeAllOrders, ownOrderCount: 0 }),
      )
    : myOrdersRead.then((own) =>
        resolveEffectiveOrdersScope({ requested: null, canSeeAllOrders, ownOrderCount: own.length }),
      );

  // The Finance queue and the four tiles' counts read in the same batch (2026-10-31, "fix the
  // slowest five pages"): neither needs anything above, and each used to wait for this whole batch
  // and then for the other. Their own notes are below, where they are used.
  const [
    workspace,
    myOrders,
    pendingValidations,
    ordersScope,
    ordersPage,
    awaitingFinanceMonth,
    totals,
    recentScopePage,
  ] = await Promise.all([
    // Only `awaiting` is drawn here — the Needs Action inbox — so held orders and the viewer's
    // decision history are not read at all.
    getDirectOrderWorkspaceData(access, { awaitingOnly: true }),
    myOrdersRead,
    needsValidations
      ? listDirectOrderPharmacyValidations(access, { status: "pending" })
      : Promise.resolve([]),
    scopeRead,
    needsOrdersPage
      ? scopeRead.then((resolved) =>
          listDirectOrderOperationalPage(access, {
            page: options.ordersPage ?? null,
            pageSize: options.ordersPageSize ?? null,
            filters: { ...(options.ordersFilters ?? {}), scopeFilter: resolved },
          }),
        )
      : Promise.resolve(null),
    listDirectOrderAwaitingFinanceMonth(access),
    countDirectOrderWorkspaceTotals(access, currentCairoSalesMonth(options.now)),
    // Overview's "Recent orders" from the wider scope, read the moment `myOrders` shows there are
    // none of the viewer's own, rather than after the whole batch.
    view === "overview" && canSeeAllOrders
      ? myOrdersRead.then((own) =>
          own.length === 0
            ? listDirectOrderOperationalPage(access, {
                page: 1,
                pageSize: 5,
                filters: { scopeFilter: "all" },
              })
            : null,
        )
      : Promise.resolve(null),
  ]);

  // Overview's "Recent orders". The viewer's own five when they have any; otherwise, for a viewer
  // who can see more than their own, the latest five in that scope.
  const ownRecent: DirectOrderQueueRow[] = myOrders.slice(0, 5);
  const recentFromScope =
    view === "overview" && canSeeAllOrders && myOrders.length === 0;
  const recentOrdersScope: DirectOrderOrdersScopeFilter = recentFromScope ? "all" : "mine";
  const recentOrders: DirectOrderQueueRow[] =
    view !== "overview"
      ? []
      : recentFromScope
        ? (recentScopePage?.rows ?? [])
        : ownRecent;

  // The Finance queue is its OWN focused read (2026-08-12) — `status = 'approved' AND sales_month
  // IS NULL`, straight from the database — rather than a filter over the whole report. It used to
  // be derived from `allOrders`, which meant opening the inbox loaded the entire Direct Orders
  // population to surface a handful of rows.
  //
  // The capability gate lives INSIDE listDirectOrderAwaitingFinanceMonth rather than out here, so
  // it cannot be forgotten by a future caller: a queue nobody can clear is how people learn to
  // ignore queues, and that rule now sits with the query instead of beside it. (`awaitingFinanceMonth`,
  // read in the batch above.)

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
  // Fetched on EVERY view. The four tiles render above every tab, so a view that skipped this read
  // printed `0 / 0 / 0 / 0` where Overview printed `0 / 24 / 3 / 3` for the same person (National
  // Sales Manager, 26 Oct 2026) — a false zero, which reads as "nothing in progress". They are four
  // COUNT queries, and if one fails the page fails, as Overview always did, rather than show a zero.
  // (`totals`, read in the batch above, on every view.)
  const summary: DirectOrderWorkspaceSummary = {
    needsMyAction: countDirectOrderNeedsAction(needsAction),
    ...totals,
  };

  const tabs = resolveDirectOrderWorkspaceTabs(access);
  const canOpenPharmacyControl = tabs.includes("pharmacy-control");
  const canOpenReports = tabs.includes("reports");
  const canOpenControls = tabs.includes("controls");

  // Retained for the component's existing capability checks and for the admin-desk link list.
  const canOpenAdminTools = canOpenPharmacyControl || canOpenReports || canOpenControls;

  return {
    summary,
    needsAction,
    myOrders,
    orders: ordersPage,
    ordersScope,
    recentOrders,
    recentOrdersScope,
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
