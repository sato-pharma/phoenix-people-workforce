"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ClipboardList,
  FileSpreadsheet,
  Inbox,
  Plus,
  RotateCcw,
  Search,
  Wrench,
} from "lucide-react";

import { DirectOrderStatusPill } from "@/components/direct-orders/direct-order-status-pill";
import { DirectOrdersTabStrip } from "@/components/direct-orders/workspace/direct-orders-tab-strip";
import { describeDirectOrderBasketUnits } from "@/lib/direct-orders/basket-label";
import type {
  DirectOrderNeedsActionGroup,
  DirectOrderQueueRow,
} from "@/lib/direct-orders/needs-action";
import {
  directOrderMatchesStatusGroup,
  resolveDirectOrderStatusGroup,
  type DirectOrderOperationalPage,
  type DirectOrderStatusGroupKey,
} from "@/lib/direct-orders/operational-query";
import type {
  DirectOrderOrdersFilterKey,
  DirectOrderWorkspaceTabKey,
} from "@/lib/direct-orders/workspace-data";
import { phxFieldClassName } from "@/components/ui/form-tokens";
import { adminPanelClassName, adminPanelDepthClassName, adminRecessedDepthClassName, adminThumbBarDepthClassName } from "@/components/admin/admin-design-tokens";

// ─────────────────────────────────────────────────────────────────────────────
// ONE Direct Orders workspace, rendered by BOTH shells.
//
// The module's surfaces were built twice — once under app/(admin) for Super
// Admin / SFE / CEO / Finance, once under app/employee-portals for the roles that
// actually raise the orders (DM / RM / NSM / PM / GPM), because
// `resolveNavigationMode` sends those two groups to different shells. That is why
// the module carried four twin pairs — submit (565/570), order detail (1005/860),
// approvals queue (156/176) and report (341/332) — and why "Approved" once had to
// be corrected in four places. All four twins were retired on 2026-08-10: both
// approvals queues into this component's Needs Action tab, and the other three
// onto their shared implementation. This component is deliberately shell-agnostic
// so the split cannot reappear: the shells differ only in `variant`, exactly as
// DirectOrderStatusPill already solved the same problem.
//
// MOBILE IS THE PRIMARY TARGET. Cards, not tables; 44px touch targets; the one
// primary action sticky at the bottom on small screens; every wide element
// scrolls inside its own container so the page body never scrolls sideways.
// ─────────────────────────────────────────────────────────────────────────────

type Variant = "admin" | "portal";

export type DirectOrdersWorkspaceProps = {
  variant: Variant;
  basePath: string;
  /** Where "+ New Order" goes. Null hides the button for a role that cannot raise one. */
  newOrderHref: string | null;
  tabs: readonly DirectOrderWorkspaceTabKey[];
  initialTab: DirectOrderWorkspaceTabKey;
  summary: { needsMyAction: number; inProgress: number; returned: number; completedThisMonth: number };
  needsAction: readonly DirectOrderNeedsActionGroup[];
  myOrders: readonly DirectOrderQueueRow[];
  /**
   * ONE PAGE of Orders, already scoped, filtered and paginated by the SERVER, and the only source
   * the Orders list has.
   *
   * Null on every view except `orders` — the loader fetches it for that view and no other. Since a
   * tab change is a navigation, `?view=orders` always arrives with this populated; the `myOrders`
   * fallback below exists only for a caller that passes no page at all.
   */
  ordersPage?: DirectOrderOperationalPage<DirectOrderQueueRow> | null;
  /** Admin desks the viewer may open — passed in so this component owns no permission rule. */
  adminTools: readonly { href: string; label: string; description: string }[];
  /**
   * Whether the viewer's scope reaches past their own orders. Drives the Orders view's filter
   * strip: an own-scope viewer is not offered a choice between two identical sets.
   */
  canSeeAllOrders: boolean;
  customersHref: string | null;
  /** The full report + xlsx export. Kept as its own route — it has filters, share links and an
   *  export the workspace tabs do not — but reached from HERE rather than its own sidebar row. */
  reportHref: string | null;
};

/**
 * Which desk answers which question. Matched on the route slug so the nav registry stays a plain
 * list of pages — only this component knows the grouping, and adding a desk means adding one slug.
 */
const PHARMACY_CONTROL_DESKS = ["/validations", "/held", "/pharmacies", "/pharmacy-variances", "/cleanup"] as const;
// `/approval-exceptions` sits under Reports & Monitoring rather than Pharmacy Control because it is
// not about pharmacies at all — it monitors the health of the approval chain itself, alongside
// reconciliation. It is also the one desk whose queue nobody else can see: a stuck rung appears in
// no approver's Needs Action, by definition.
const REPORT_DESKS = ["/report", "/rep-counters", "/reconciliation", "/approval-exceptions"] as const;
const CONTROL_DESKS = ["/caps"] as const;

const ORDERS_FILTERS: readonly { key: DirectOrderOrdersFilterKey; label: string }[] = [
  { key: "mine", label: "Mine" },
  // "My team" is deliberately absent rather than faked: the rows the workspace already holds
  // cannot distinguish a direct report's order from anyone else's in scope without resolving the
  // seat model, and that walk was removed from this path on purpose for its cost. Offering a
  // filter that silently returned the wrong set would be worse than offering two honest ones.
  { key: "all", label: "All in my scope" },
];

/** A grouped set of desks, introduced by what the group is FOR rather than by a permission name. */
function DeskGroup({
  tools,
  variant,
  intro,
  emptyMessage,
}: {
  tools: readonly { href: string; label: string; description: string }[];
  variant: Variant;
  intro: string;
  emptyMessage: string;
}) {
  if (tools.length === 0) {
    return <div className={`${surface(variant)} px-4 py-8 text-center text-sm text-slate-500`}>{emptyMessage}</div>;
  }
  return (
    <div className="space-y-3">
      <p className="px-1 text-phx-sm leading-5 text-slate-500">{intro}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {tools.map((tool) => (
          <Link
            key={tool.href}
            href={tool.href}
            className={`${surface(variant)} flex min-h-[44px] items-start gap-3 p-4 transition-colors hover:bg-orange-50/40`}
          >
            <Wrench className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
            <span className="min-w-0">
              <span className="block text-sm font-bold text-slate-900">{tool.label}</span>
              <span className="mt-0.5 block text-phx-xs leading-4 text-slate-500">{tool.description}</span>
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}

// TAB_LABEL moved to direct-orders-tab-strip.tsx, beside the strip that renders it, so the desk
// shell and this component cannot disagree about what a tab is called.

const money = (value: number) => `${Math.round(value).toLocaleString("en-US")} EGP`;
const shortDate = (value: string | null) => (value ? String(value).slice(0, 10) : "—");

/** The two visual families the owner's rule preserves: square admin, rounded portal. */
const surface = (variant: Variant) =>
  variant === "portal"
    ? `rounded-xl border border-slate-200 bg-white ${adminPanelDepthClassName}`
    : adminPanelClassName;

const control = (variant: Variant) => (variant === "portal" ? "rounded-lg" : "");

// ── Summary cards ────────────────────────────────────────────────────────────

const TONE_RING: Record<string, string> = {
  amber: "bg-amber-50 text-amber-700 ring-amber-200",
  sky: "bg-sky-50 text-sky-700 ring-sky-200",
  rose: "bg-rose-50 text-rose-700 ring-rose-200",
  emerald: "bg-emerald-50 text-emerald-700 ring-emerald-200",
};

function SummaryCard({
  icon,
  label,
  value,
  hint,
  tone,
  variant,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  value: number;
  hint: string;
  tone: keyof typeof TONE_RING;
  variant: Variant;
  onClick?: () => void;
}) {
  const body = (
    <>
      <div className="flex items-center gap-2">
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center ring-1 ${TONE_RING[tone]} ${control(variant)}`}>
          {icon}
        </span>
        <span className="text-phx-xs font-black uppercase tracking-wide text-slate-500">{label}</span>
      </div>
      <p className="mt-2 text-2xl font-black tabular-nums text-slate-950">{value.toLocaleString("en-US")}</p>
      <p className="mt-0.5 text-phx-xs text-slate-500">{hint}</p>
    </>
  );
  const className = `${surface(variant)} min-h-[44px] p-3 text-left transition-colors ${
    onClick ? "hover:bg-orange-50/40" : ""
  }`;
  return onClick ? (
    <button type="button" onClick={onClick} className={className}>
      {body}
    </button>
  ) : (
    <div className={className}>{body}</div>
  );
}

// ── Needs Action inbox ───────────────────────────────────────────────────────

/** How many of a group's items show before "See all" — one screenful, not a page. */
const NEEDS_ACTION_PREVIEW = 5;

function NeedsActionInbox({
  groups,
  variant,
  emptyMessage,
  expandedKind,
  returnTo,
}: {
  groups: readonly DirectOrderNeedsActionGroup[];
  variant: Variant;
  emptyMessage: string;
  /**
   * The `?queue=` group, shown in full instead of previewed.
   *
   * This param has been in every group's `seeAllHref` since the inbox was built and NOTHING read
   * it — so "See all 12" navigated to the view the reader was already on and still showed five.
   * A link that restates its own page is worse than no link: the reader concludes the other seven
   * do not exist.
   */
  expandedKind?: string | null;
  /** The list URL to return to from an item's detail. See withReturnTo. */
  returnTo?: string | null;
}) {
  if (groups.length === 0) {
    return (
      <div className={`${surface(variant)} px-4 py-10 text-center`}>
        <CheckCircle2 className="mx-auto h-6 w-6 text-emerald-500" aria-hidden="true" />
        <p className="mt-2 text-sm font-bold text-slate-900">Nothing needs you right now</p>
        <p className="mt-1 text-xs text-slate-500">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {groups.map((group) => {
        const expanded = expandedKind === group.kind;
        const shown = expanded ? group.items : group.items.slice(0, NEEDS_ACTION_PREVIEW);
        return (
        <section key={group.kind} className={surface(variant)}>
          <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-100 px-4 py-3">
            <h3 className="text-sm font-black text-slate-950">{group.headline}</h3>
            {group.totalValue > 0 ? (
              <span className="text-phx-xs font-bold tabular-nums text-slate-500">{money(group.totalValue)}</span>
            ) : null}
          </header>

          {group.items.length === 0 ? (
            <Link
              href={group.seeAllHref}
              className="flex min-h-[44px] items-center justify-between gap-2 px-4 py-3 text-sm font-bold text-orange-700 hover:bg-orange-50/40"
            >
              {group.actionLabel}
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          ) : (
            <ul>
              {shown.map((item) => (
                <li key={item.id} className="border-b border-slate-100 last:border-b-0">
                  <Link
                    href={withReturnTo(item.href, returnTo ?? null)}
                    className="flex min-h-[56px] items-center gap-3 px-4 py-3 transition-colors hover:bg-orange-50/40"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-bold text-slate-900">{item.title}</p>
                      <p className="truncate text-phx-xs text-slate-500">{item.subtitle}</p>
                    </div>
                    {item.flagged ? (
                      <span className="shrink-0 rounded-full bg-phx-danger-bg px-1.5 py-0.5 text-phx-3xs font-black uppercase tracking-wide text-phx-danger">
                        over cap
                      </span>
                    ) : null}
                    <span className="shrink-0 text-phx-xs font-black text-orange-700">{group.actionLabel}</span>
                  </Link>
                </li>
              ))}
              {group.items.length > shown.length ? (
                <li>
                  <Link
                    href={group.seeAllHref}
                    className="flex min-h-[44px] items-center justify-center gap-1 px-4 py-3 text-xs font-black text-slate-600 hover:bg-slate-50"
                  >
                    See all {group.count}
                    <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </Link>
                </li>
              ) : null}
            </ul>
          )}
        </section>
        );
      })}
    </div>
  );
}

// ── Orders list (search + filters, replacing the per-status pages) ───────────

/**
 * The five buckets that replace separate Pending / Approved / Rejected / Finance
 * pages. Each maps to STAGES from the shared vocabulary, never to a hand-written
 * list of database statuses — so a status added to the union lands in a bucket
 * instead of silently disappearing from every filter.
 */
const FILTERS = [
  { key: "all", label: "All" },
  { key: "needs-action", label: "Needs Action" },
  { key: "in-progress", label: "In Progress" },
  { key: "returned", label: "Returned" },
  { key: "completed", label: "Completed" },
] as const satisfies readonly { key: DirectOrderStatusGroupKey; label: string }[];

/**
 * The chip keys ARE the server's group keys — aliased, not re-declared, so a chip cannot be added
 * here that the query has no way to answer. `satisfies` above is the other half: a label typo in a
 * key fails to compile rather than producing a chip that silently matches nothing.
 */
type FilterKey = DirectOrderStatusGroupKey;

/**
 * The grouping rule now lives in operational-query.ts, because the SERVER has to answer the same
 * question these chips ask. It was defined here, privately, which is why the chips could only ever
 * filter rows already on screen — the database had no way to express "In Progress".
 */
function matchesFilter(row: DirectOrderQueueRow, filter: FilterKey): boolean {
  return directOrderMatchesStatusGroup({ status: String(row.status), salesMonth: row.salesMonth }, filter);
}

/**
 * Free-text search over the fields a person actually remembers: who raised it, the
 * pharmacy by name OR customer code, the product, the area or region, the covering
 * rep, and the order id.
 *
 * `pharmacyCode` and `medicalRepName` are optional on the row, and that is not
 * sloppiness — it is the truth about where each one comes from. Rows built from
 * `DirectOrderApprovalListItem` (My Orders, Needs Action) carry both; rows built
 * from `DirectOrderReportRow` (All Orders) carry the code but not the rep, because
 * the report path never resolves reps and making it do so would re-introduce the
 * seat-model walk that was just taken OFF the badge path. `filter(Boolean)` drops
 * whichever is absent, and `searchPlaceholder` below only advertises the rep where
 * it is actually searchable.
 */
function matchesQuery(row: DirectOrderQueueRow, query: string): boolean {
  if (!query) return true;
  const haystack = [
    row.requesterName,
    row.pharmacyName,
    row.pharmacyCode,
    row.productName,
    row.areaName,
    row.regionName,
    row.medicalRepName,
    row.id,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => haystack.includes(term));
}

/**
 * Describe only what THIS row set can actually be searched by.
 *
 * A single hardcoded placeholder would either omit the rep on the tab where it
 * works, or promise it on the tab where it silently does not — and a search box
 * that lists a field it cannot match is worse than one that stays quiet about it.
 *
 * SERVER MODE omits AREA and REGION, and says so rather than listing them.
 * `listDirectOrderOperationalPage` resolves pharmacy and person to ids before
 * querying, so those are matched for real; area and region names come from the
 * geo tables via the pharmacy, a hop further than the search reaches. The rep is
 * likewise not resolved on this path.
 *
 * The in-memory lists keep the wider search, because they genuinely hold the
 * decorated rows. This is the one place the two paths differ in capability, and
 * the placeholder is where the person finds that out — before they type an area
 * name and conclude their order does not exist.
 */
function searchPlaceholder(rows: readonly DirectOrderQueueRow[], server: boolean): string {
  if (server) return "Search by person, pharmacy or code, product or order id";
  const hasRep = rows.some((row) => Boolean(row.medicalRepName));
  return hasRep
    ? "Search by person, rep, pharmacy or code, product, area or order id"
    : "Search by person, pharmacy or code, product, area or order id";
}

/**
 * Append the list the reader is leaving, so the detail's Back can return them to it.
 *
 * Only the client knows this — the hrefs are otherwise built server-side, where the query string
 * the reader assembled does not exist. The detail page validates it before use
 * (`resolveDirectOrderReturnHref`); nothing here is trusted just because this file wrote it.
 */
function withReturnTo(href: string, returnTo: string | null): string {
  return returnTo ? `${href}?from=${encodeURIComponent(returnTo)}` : href;
}

/**
 * One entry per product, each with its own units. A row built without `items` (one built before
 * baskets, or a hand-built one) is a one-product order and is its own single line — `qty` is only
 * ever null on a basket, which always carries its items.
 */
function orderRowLines(
  row: DirectOrderQueueRow,
): readonly { productCode: string; productName: string; qty: number | null }[] {
  return row.items ?? [{ productCode: "", productName: row.productName, qty: row.qty }];
}

function OrderRow({
  row,
  basePath,
  variant,
  returnTo,
}: {
  row: DirectOrderQueueRow;
  basePath: string;
  variant: Variant;
  returnTo?: string | null;
}) {
  return (
    <li className="border-b border-slate-100 last:border-b-0">
      <Link
        href={withReturnTo(`${basePath}/${encodeURIComponent(row.id)}`, returnTo ?? null)}
        className="flex min-h-[64px] flex-col gap-1.5 px-4 py-3 transition-colors hover:bg-orange-50/40"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            {/* ONE LINE PER PRODUCT on a basket, never a joined string. The value on the right is
                the WHOLE basket, so a lone "Lacto Advanced 1 × 72" beside 25,344 EGP named one
                product against two products' money (owner, 2026-08-13). Joining the names would
                only make the string longer than the row and hand it straight back to `truncate` —
                and an ellipsis is precisely what must never happen here. Each product gets its own
                line instead, so the row grows by one line rather than hiding a product.
                The fallback covers a row built before `items` existed, and any hand-built row. */}
            {orderRowLines(row).map((item, index) => (
              <p
                key={`${item.productCode || item.productName}-${index}`}
                className="break-words text-sm font-bold text-slate-900"
              >
                {describeDirectOrderBasketUnits(item)}
              </p>
            ))}
            <p className="break-words text-phx-xs text-slate-500">
              {row.requesterName} · {row.pharmacyName}
            </p>
          </div>
          <p className="shrink-0 text-sm font-black tabular-nums text-slate-950">{money(row.salesValue)}</p>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <DirectOrderStatusPill
            status={row.status}
            salesMonth={row.salesMonth}
            variant={variant === "portal" ? "ring" : "solid"}
          />
          <span className="text-phx-xs text-slate-500">
            {row.areaName || row.regionName || "—"} · {shortDate(row.createdAt)}
          </span>
        </div>
      </Link>
    </li>
  );
}

/** Pages of 25. The workspace must not become the one enormous page the brief warns about. */
const PAGE_SIZE = 25;

function OrdersList({
  rows,
  basePath,
  variant,
  emptyMessage,
  initialFilter,
  server,
  returnTo,
}: {
  rows: readonly DirectOrderQueueRow[];
  basePath: string;
  variant: Variant;
  emptyMessage: string;
  initialFilter?: FilterKey;
  /** The list URL to return to from an order's detail. See withReturnTo. */
  returnTo?: string | null;
  /**
   * SERVER MODE. When set, `rows` is one already-searched, already-filtered page from the database
   * and this component must not narrow it again — the search box and status chips push to the URL
   * instead, and the server answers.
   *
   * Absent for the legacy in-memory lists (Needs Action groups, "recent orders" on Overview), which
   * genuinely hold everything they display and are small by construction.
   */
  server?: {
    query: string;
    group: FilterKey;
    onQueryChange: (next: string) => void;
    onGroupChange: (next: FilterKey) => void;
  };
}) {
  const [query, setQuery] = useState(server?.query ?? "");
  const [localFilter, setLocalFilter] = useState<FilterKey>(initialFilter ?? "all");
  const [shown, setShown] = useState(PAGE_SIZE);

  // DERIVED in server mode, not mirrored. The chip's selection IS the URL there, so holding a copy
  // in state and syncing it from an effect would be two sources of truth for one fact — and the
  // copy is the one that goes stale on Back. `localFilter` exists only for the in-memory lists,
  // which have no URL to read.
  const filter: FilterKey = server ? server.group : localFilter;

  // Deps are PRIMITIVES, never `server` itself: the call site builds that object inline, so it is a
  // new identity on every parent render and an effect keyed on it would clear and restart the
  // debounce timer each time — a debounce that never fires while anything else re-renders.
  const serverQuery = server?.query ?? null;
  const pushQuery = server?.onQueryChange;
  const pushQueryRef = useRef(pushQuery);
  useEffect(() => {
    pushQueryRef.current = pushQuery;
  });

  // The URL moved underneath us — Back, Forward, or someone opening a shared link. Adopt it.
  // Without this the box keeps the text the person typed, the push effect below sees it differs
  // from the URL, and it navigates FORWARD again: the Back button would appear broken on the one
  // screen this whole phase exists to make navigable.
  const lastServerQuery = useRef(serverQuery);
  useEffect(() => {
    if (serverQuery === null || lastServerQuery.current === serverQuery) return;
    lastServerQuery.current = serverQuery;
    setQuery(serverQuery);
  }, [serverQuery]);

  // DEBOUNCED, and only in server mode. Typing "el salam" must not be eight navigations — and the
  // 300ms is deliberately longer than the pharmacy combo box's 250ms because this one re-runs a
  // scoped, counted query rather than a single indexed lookup.
  //
  // The equality guard is what stops the loop: every arrival from the server re-runs this effect,
  // and without it the component would push the value it just received straight back.
  useEffect(() => {
    if (serverQuery === null || query === serverQuery) return;
    const timer = setTimeout(() => pushQueryRef.current?.(query), 300);
    return () => clearTimeout(timer);
  }, [query, serverQuery]);

  const filtered = useMemo(
    // In server mode the rows ARE the result — filtering them again would narrow a set the database
    // already decided, and would make page 2 of a search show fewer than 25 rows for no reason.
    () => (server ? rows : rows.filter((row) => matchesFilter(row, filter) && matchesQuery(row, query))),
    [rows, filter, query, server],
  );

  // Counts are computed from the rows on screen, which in server mode is ONE PAGE — so they would
  // read "3 returned" when the scoped set holds 300. Rather than show a number that is wrong,
  // server mode renders the chips without counts. A missing count is honest; a page-local one
  // pretending to be a total is not.
  const counts = useMemo(() => {
    if (server) return null;
    const out: Record<string, number> = {};
    for (const entry of FILTERS) out[entry.key] = rows.filter((row) => matchesFilter(row, entry.key)).length;
    return out;
  }, [rows, server]);

  return (
    <div className="space-y-3">
      <label className="relative block">
        <span className="sr-only">Search direct orders</span>
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
        <input
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setShown(PAGE_SIZE);
          }}
          placeholder={searchPlaceholder(rows, Boolean(server))}
          className={`${phxFieldClassName} pl-9 ${control(variant)}`}
        />
      </label>

      {/* The status chips WRAP onto a second row. A scrolling strip measured 468px in 359px at 375px
          and cut the last chip off (fits-the-screen golden rule). */}
      <div className={`inline-flex max-w-full flex-wrap border border-slate-300 bg-white p-1 ${adminRecessedDepthClassName} ${control(variant)}`} role="tablist">
        {FILTERS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={filter === entry.key}
            onClick={() => {
              setLocalFilter(entry.key);
              setShown(PAGE_SIZE);
              server?.onGroupChange(entry.key);
            }}
            className={`min-h-[36px] px-3 py-1.5 text-phx-sm font-black uppercase tracking-wide transition-colors ${control(variant)} ${
              filter === entry.key ? "bg-slate-900 text-white" : "text-slate-500 hover:bg-slate-100"
            }`}
          >
            {entry.label}
            {counts ? <span className="ml-1 opacity-70">{counts[entry.key] ?? 0}</span> : null}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className={`${surface(variant)} px-4 py-10 text-center text-sm text-slate-500`}>
          {query || filter !== "all" ? "No orders match this search." : emptyMessage}
        </div>
      ) : (
        <div className={surface(variant)}>
          <ul>
            {filtered.slice(0, shown).map((row) => (
              <OrderRow key={row.id} row={row} basePath={basePath} variant={variant} returnTo={returnTo} />
            ))}
          </ul>
          {/* Never in server mode: `filtered` IS one page there, and a second "show more" above the
              real pagination controls would page through the page. Stated rather than left to the
              coincidence that both sizes are currently 25. */}
          {!server && filtered.length > shown ? (
            <button
              type="button"
              onClick={() => setShown((current) => current + PAGE_SIZE)}
              className="flex min-h-[44px] w-full items-center justify-center border-t border-slate-100 text-xs font-black text-slate-600 hover:bg-slate-50"
            >
              Show more ({filtered.length - shown} left)
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

// ── The workspace ────────────────────────────────────────────────────────────

export function DirectOrdersWorkspace(props: DirectOrdersWorkspaceProps) {
  const { variant, basePath, newOrderHref, tabs, summary, needsAction, myOrders, adminTools } = props;
  const router = useRouter();
  const searchParams = useSearchParams();

  // ── STATE LIVES IN THE URL, NOT IN useState ────────────────────────────────
  //
  // Tab, scope filter, status, search and page were all component state, which meant: Back left the
  // workspace entirely, a refresh dropped you on Overview, a filtered list could not be sent to a
  // colleague, and — the reason this mattered most — Order Detail had nowhere to return you to, so
  // it sent everyone to the workspace root regardless of where they came from.
  //
  // Reading them from the URL makes each of those work for free, and lets the SERVER fetch the
  // right page: a tab change is now a navigation, so `loadDirectOrderWorkspaceView` runs again for
  // the view being opened rather than the view you left.
  const tab: DirectOrderWorkspaceTabKey = tabs.includes(props.initialTab) ? props.initialTab : "overview";
  const ordersFilter: DirectOrderOrdersFilterKey =
    searchParams.get("scope") === "all" ? "all" : "mine";
  // Read from the URL, not held in state: this is what makes a filtered, searched list a link
  // somebody can send, and what makes Back return to the previous filter rather than leaving
  // Direct Orders entirely.
  const ordersQuery = searchParams.get("q") ?? "";
  const ordersGroup = resolveDirectOrderStatusGroup(searchParams.get("group"));
  // Which Needs Action group "See all" asked to open. Only Needs Action honours it — Overview's
  // copy of the inbox is a preview by design, and its See-all links point HERE.
  const expandedQueue = searchParams.get("queue");

  /**
   * The exact list URL an order's detail should return to.
   *
   * Built from the CURRENT params, so it carries the tab, scope, chip, search and page the reader
   * assembled. The detail page validates it before use — a value that reaches a link through the
   * query string is not trusted merely because this component is the one that put it there.
   */
  const returnTo = useMemo(() => {
    const qs = searchParams.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  }, [searchParams, basePath]);

  /**
   * Build the next URL from the current one, so an unrelated param a future feature adds is not
   * silently dropped by a tab click. A null value REMOVES the key — that is how the URL stays short
   * for the default case instead of accumulating `&status=&q=` noise.
   */
  const pushParams = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    }
    const qs = next.toString();
    router.push(qs ? `${basePath}?${qs}` : basePath, { scroll: false });
  };

  // Any change to WHAT is being listed resets to page 1. Staying on page 3 while narrowing a filter
  // is how you end up looking at an empty list and concluding there are no results.
  const goTab = (next: DirectOrderWorkspaceTabKey) => pushParams({ view: next, page: null });
  const goOrdersFilter = (next: DirectOrderOrdersFilterKey) =>
    pushParams({ scope: next === "mine" ? null : next, page: null });
  const goPage = (next: number) => pushParams({ page: next <= 1 ? null : String(next) });

  // The server page wins whenever it is present: it is already scoped, filtered and paginated in
  // the database, so re-filtering it here would narrow a set the server already decided.
  //
  // The fallback is the pre-2026-08-12 behaviour and is only reached when `ordersPage` is absent.
  const servedPage = props.ordersPage ?? null;
  // `myOrders` is the fallback only for a caller that passes no server page at all. It is NOT the
  // wide list: the `allOrders` fallback that used to sit here is gone, and with it the last
  // full-table read on a routine screen. It was reachable only while tab switching was client-side;
  // now that a tab is a navigation, ?view=orders always arrives with its own server page.
  const ordersRows = servedPage ? servedPage.rows : myOrders;

  // An own-scope viewer has no wider set to switch to, so the strip is not rendered — rather than
  // offering a control with one working position.
  const showOrdersScopeStrip = props.canSeeAllOrders;

  // The desks are partitioned by the QUESTION they answer, matched on their route. Grouping here
  // rather than in the nav registry keeps this component the only place that knows the new IA,
  // so the registry stays a plain list of pages and nothing else has to learn the grouping.
  const pharmacyControlTools = adminTools.filter((tool) => PHARMACY_CONTROL_DESKS.some((slug) => tool.href.includes(slug)));
  const reportTools = adminTools.filter((tool) => REPORT_DESKS.some((slug) => tool.href.includes(slug)));
  const controlTools = adminTools.filter((tool) => CONTROL_DESKS.some((slug) => tool.href.includes(slug)));

  const goNeedsAction = () => goTab("needs-action");

  return (
    <div className="space-y-4 pb-20 sm:pb-0">
      {/* The one primary action. Sticky at the bottom on mobile, inline on desktop —
          the brief's "sticky primary actions", and it is the only orange button on
          the screen so it cannot be confused with a filter. */}
      {newOrderHref ? (
        <>
          <div className="hidden sm:flex sm:justify-end">
            <Link
              href={newOrderHref}
              className={`inline-flex min-h-[44px] items-center gap-2 bg-orange-600 px-4 text-sm font-black text-white transition hover:bg-orange-700 ${control(variant)}`}
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              New Order
            </Link>
          </div>
          <div className={`fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 p-3 backdrop-blur sm:hidden ${adminThumbBarDepthClassName}`}>
            <Link
              href={newOrderHref}
              className={`flex min-h-[48px] items-center justify-center gap-2 bg-orange-600 text-sm font-black text-white ${control(variant)}`}
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              New Order
            </Link>
          </div>
        </>
      ) : null}

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <SummaryCard
          icon={<Inbox className="h-4 w-4" />}
          label="Needs my action"
          value={summary.needsMyAction}
          hint="Waiting on you"
          tone="amber"
          variant={variant}
          onClick={goNeedsAction}
        />
        <SummaryCard
          icon={<ClipboardList className="h-4 w-4" />}
          label="In progress"
          value={summary.inProgress}
          hint="Moving through approval"
          tone="sky"
          variant={variant}
        />
        <SummaryCard
          icon={<RotateCcw className="h-4 w-4" />}
          label="Returned"
          value={summary.returned}
          hint="Sent back for a change"
          tone="rose"
          variant={variant}
        />
        <SummaryCard
          icon={<CheckCircle2 className="h-4 w-4" />}
          label="Completed"
          value={summary.completedThisMonth}
          hint="Booked into this month"
          tone="emerald"
          variant={variant}
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
      {/* THE SHARED STRIP. Rendered identically above every desk under (desks)/, which is what makes
          Pharmacy Validation or the Held Desk feel like a tab of this module rather than a
          departure from it.

          It navigates by <Link> rather than by click handler, so a tab is a real URL — right-click,
          middle-click and "copy link" all behave. `goTab` survives for the in-CONTENT shortcuts
          below ("view all", the empty-state jump to Orders), which are buttons inside a view rather
          than the navigation chrome. */}
      <DirectOrdersTabStrip
        tabs={tabs}
        activeTab={tab}
        basePath={basePath}
        needsActionCount={summary.needsMyAction}
        rounded={variant === "portal"}
      />
      {props.reportHref ? (
        <Link
          href={props.reportHref}
          className="inline-flex min-h-[40px] items-center gap-1.5 px-2 text-phx-sm font-black uppercase tracking-wide text-slate-500 hover:text-orange-700"
        >
          <FileSpreadsheet className="h-3.5 w-3.5" aria-hidden="true" />
          Report
        </Link>
      ) : null}
      </div>

      {tab === "overview" ? (
        <div className="space-y-4">
          <NeedsActionInbox
            groups={needsAction}
            variant={variant}
            emptyMessage="When an order needs your approval, a correction, or a pharmacy verified, it appears here."
            returnTo={returnTo}
          />
          <section className={surface(variant)}>
            <header className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
              <h3 className="text-sm font-black text-slate-950">Recent orders</h3>
              {/* min-h-[44px] and -my-2 so the tap target reaches the floor without pushing the
                  header taller. Measured at 375x812 before the fix: 17px, the only control in the
                  workspace under 40. */}
              <button
                type="button"
                onClick={() => goTab("orders")}
                className="-my-2 inline-flex min-h-[44px] items-center px-2 text-phx-xs font-black text-orange-700"
              >
                See all
              </button>
            </header>
            {myOrders.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-slate-500">You have not raised a direct order yet.</p>
            ) : (
              <ul>
                {myOrders.slice(0, 5).map((row) => (
                  <OrderRow key={row.id} row={row} basePath={basePath} variant={variant} returnTo={returnTo} />
                ))}
              </ul>
            )}
          </section>
        </div>
      ) : null}

      {tab === "needs-action" ? (
        <NeedsActionInbox
          groups={needsAction}
          variant={variant}
          emptyMessage="Nothing is waiting on you across approvals, corrections, pharmacy verification or Finance."
          expandedKind={expandedQueue}
          returnTo={returnTo}
        />
      ) : null}

      {/* ORDERS — one view, scope as a FILTER rather than as two tabs.
          Which orders a person may see is a permission question the server has already answered;
          making the user pick between "My Orders" and "All Orders" asked them to answer it again,
          in the module's own vocabulary. An own-scope viewer sees no filter strip at all, because
          for them the two sets are identical. */}
      {tab === "orders" ? (
        <div className="space-y-3">
          {showOrdersScopeStrip ? (
            <div className={`inline-flex min-w-max border border-slate-300 bg-white p-1 ${adminRecessedDepthClassName} ${control(variant)}`} role="tablist">
              {ORDERS_FILTERS.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  role="tab"
                  aria-selected={ordersFilter === option.key}
                  onClick={() => goOrdersFilter(option.key)}
                  className={`min-h-[36px] px-3 text-phx-sm font-black transition-colors ${
                    ordersFilter === option.key ? "bg-slate-900 text-white" : "text-slate-500 hover:bg-slate-100"
                  } ${control(variant)}`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          ) : null}
          <OrdersList
            rows={ordersRows}
            basePath={basePath}
            variant={variant}
            emptyMessage={
              ordersFilter === "mine"
                ? "You have not raised a direct order yet."
                : "No direct orders in your scope yet."
            }
            // Only when a server page is in play. Handing these to the legacy in-memory path would
            // navigate for a filter that array already answers locally, and correctly.
            returnTo={returnTo}
            server={
              servedPage
                ? {
                    query: ordersQuery,
                    group: ordersGroup,
                    onQueryChange: (next) => pushParams({ q: next || null, page: null }),
                    onGroupChange: (next) => pushParams({ group: next === "all" ? null : next, page: null }),
                  }
                : undefined
            }
          />

          {/* Server pagination. Rendered only when a server page is in play — the legacy path has
              its own "Show more" inside OrdersList. The count is the DATABASE count over the scoped
              and filtered set, so "1–25 of 4,312" is a fact rather than "however many we loaded". */}
          {servedPage && servedPage.totalCount > servedPage.pageSize ? (
            <nav
              className="flex items-center justify-between gap-3 px-1"
              aria-label="Orders pagination"
            >
              <p className="text-phx-xs font-bold tabular-nums text-slate-500">
                {(servedPage.page - 1) * servedPage.pageSize + 1}–
                {Math.min(servedPage.page * servedPage.pageSize, servedPage.totalCount)} of{" "}
                {servedPage.totalCount.toLocaleString("en-US")}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => goPage(servedPage.page - 1)}
                  disabled={servedPage.page <= 1}
                  className={`min-h-[44px] border border-slate-300 px-3 text-phx-sm font-black text-slate-700 disabled:opacity-40 ${control(variant)}`}
                >
                  Previous
                </button>
                <button
                  type="button"
                  onClick={() => goPage(servedPage.page + 1)}
                  disabled={servedPage.page * servedPage.pageSize >= servedPage.totalCount}
                  className={`min-h-[44px] border border-slate-300 px-3 text-phx-sm font-black text-slate-700 disabled:opacity-40 ${control(variant)}`}
                >
                  Next
                </button>
              </div>
            </nav>
          ) : null}
        </div>
      ) : null}

      {/* The three authority views. Each groups the desks that answer ONE kind of question, so a
          user picks by what they are doing rather than by which permission level a tool sits at.
          The desks remain their own routes — deep-linkable, bookmarkable, refresh-safe — but they
          are reached from inside the workspace and grouped by task, not presented as one
          undifferentiated grid of eight cards. */}
      {tab === "pharmacy-control" ? (
        <DeskGroup
          tools={pharmacyControlTools}
          variant={variant}
          intro="Deciding whether a pharmacy is real, correctly mapped and safe to order against — and releasing the orders waiting on that answer."
          emptyMessage="No pharmacy control tools are available for your role."
        />
      ) : null}

      {tab === "reports" ? (
        <DeskGroup
          tools={reportTools}
          variant={variant}
          intro="Monitoring and analysis: the full order record, how reps are behaving, and whether the module's injected sales reconcile with the manual upload."
          emptyMessage="No reporting tools are available for your role."
        />
      ) : null}

      {tab === "controls" ? (
        <DeskGroup
          tools={controlTools}
          variant={variant}
          intro="Commercial configuration. These settings shape what every future order is allowed to offer — they are not an order queue."
          emptyMessage="No commercial controls are available for your role."
        />
      ) : null}

      {needsAction.some((group) => group.kind === "verify_customer") && tab === "overview" ? (
        <p className="flex items-start gap-2 px-1 text-phx-xs text-slate-500">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden="true" />
          An order waiting on pharmacy verification is in nobody&apos;s approval queue, and it expires 14 days after
          it was raised.
        </p>
      ) : null}
    </div>
  );
}
