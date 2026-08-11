"use client";

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
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
  Store,
  Wrench,
} from "lucide-react";

import { DirectOrderStatusPill } from "@/components/direct-orders/direct-order-status-pill";
import { describeDirectOrderStatus } from "@/lib/direct-orders/status-labels";
import type {
  DirectOrderNeedsActionGroup,
  DirectOrderQueueRow,
} from "@/lib/direct-orders/needs-action";
import type {
  DirectOrderOrdersFilterKey,
  DirectOrderWorkspaceTabKey,
} from "@/lib/direct-orders/workspace-data";

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
  allOrders: readonly DirectOrderQueueRow[];
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
const REPORT_DESKS = ["/report", "/rep-counters", "/reconciliation"] as const;
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
      <p className="px-1 text-[12px] leading-5 text-slate-500">{intro}</p>
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
              <span className="mt-0.5 block text-[11px] leading-4 text-slate-500">{tool.description}</span>
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}

const TAB_LABEL: Record<DirectOrderWorkspaceTabKey, string> = {
  overview: "Overview",
  "needs-action": "Needs Action",
  orders: "Orders",
  // Named for the work, not the permission level. "Admin Tools" described who was allowed in
  // rather than what they came to do, which is why everything ended up inside it.
  "pharmacy-control": "Pharmacy Control",
  reports: "Reports & Monitoring",
  controls: "Commercial Controls",
};

const money = (value: number) => `${Math.round(value).toLocaleString("en-US")} EGP`;
const shortDate = (value: string | null) => (value ? String(value).slice(0, 10) : "—");

/** The two visual families the owner's rule preserves: square admin, rounded portal. */
const surface = (variant: Variant) =>
  variant === "portal"
    ? "rounded-xl border border-slate-200 bg-white"
    : "border border-[#e4e9ec] bg-white";

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
        <span className="text-[11px] font-black uppercase tracking-wide text-slate-500">{label}</span>
      </div>
      <p className="mt-2 text-2xl font-black tabular-nums text-slate-950">{value.toLocaleString("en-US")}</p>
      <p className="mt-0.5 text-[11px] text-slate-500">{hint}</p>
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

function NeedsActionInbox({
  groups,
  variant,
  emptyMessage,
}: {
  groups: readonly DirectOrderNeedsActionGroup[];
  variant: Variant;
  emptyMessage: string;
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
      {groups.map((group) => (
        <section key={group.kind} className={surface(variant)}>
          <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-100 px-4 py-3">
            <h3 className="text-sm font-black text-slate-950">{group.headline}</h3>
            {group.totalValue > 0 ? (
              <span className="text-[11px] font-bold tabular-nums text-slate-500">{money(group.totalValue)}</span>
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
              {group.items.slice(0, 5).map((item) => (
                <li key={item.id} className="border-b border-slate-100 last:border-b-0">
                  <Link
                    href={item.href}
                    className="flex min-h-[56px] items-center gap-3 px-4 py-3 transition-colors hover:bg-orange-50/40"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-bold text-slate-900">{item.title}</p>
                      <p className="truncate text-[11px] text-slate-500">{item.subtitle}</p>
                    </div>
                    {item.flagged ? (
                      <span className="shrink-0 rounded-full bg-rose-100 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wide text-rose-700">
                        over cap
                      </span>
                    ) : null}
                    <span className="shrink-0 text-[11px] font-black text-orange-700">{group.actionLabel}</span>
                  </Link>
                </li>
              ))}
              {group.items.length > 5 ? (
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
      ))}
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
] as const;

type FilterKey = (typeof FILTERS)[number]["key"];

function matchesFilter(row: DirectOrderQueueRow, filter: FilterKey): boolean {
  if (filter === "all") return true;
  if (filter === "returned") return String(row.status) === "returned";
  const { stage, actionable } = describeDirectOrderStatus(row.status, row.salesMonth);
  if (filter === "needs-action") return actionable;
  if (filter === "in-progress") return stage === "approval" || stage === "customer_check" || stage === "finance";
  return stage === "completed";
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
 */
function searchPlaceholder(rows: readonly DirectOrderQueueRow[]): string {
  const hasRep = rows.some((row) => Boolean(row.medicalRepName));
  return hasRep
    ? "Search by person, rep, pharmacy or code, product, area or order id"
    : "Search by person, pharmacy or code, product, area or order id";
}

function OrderRow({ row, basePath, variant }: { row: DirectOrderQueueRow; basePath: string; variant: Variant }) {
  return (
    <li className="border-b border-slate-100 last:border-b-0">
      <Link
        href={`${basePath}/${encodeURIComponent(row.id)}`}
        className="flex min-h-[64px] flex-col gap-1.5 px-4 py-3 transition-colors hover:bg-orange-50/40"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-bold text-slate-900">
              {row.productName} × {row.qty.toLocaleString("en-US")}
            </p>
            <p className="truncate text-[11px] text-slate-500">
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
          <span className="text-[11px] text-slate-500">
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
}: {
  rows: readonly DirectOrderQueueRow[];
  basePath: string;
  variant: Variant;
  emptyMessage: string;
  initialFilter?: FilterKey;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterKey>(initialFilter ?? "all");
  const [shown, setShown] = useState(PAGE_SIZE);

  const filtered = useMemo(
    () => rows.filter((row) => matchesFilter(row, filter) && matchesQuery(row, query)),
    [rows, filter, query],
  );

  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const entry of FILTERS) out[entry.key] = rows.filter((row) => matchesFilter(row, entry.key)).length;
    return out;
  }, [rows]);

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
          placeholder={searchPlaceholder(rows)}
          className={`h-11 w-full border border-slate-300 bg-white pl-9 pr-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-orange-400 focus:outline-none ${control(variant)}`}
        />
      </label>

      <div className="-mx-1 overflow-x-auto px-1">
        <div className={`inline-flex min-w-max border border-slate-300 bg-white p-1 ${control(variant)}`} role="tablist">
          {FILTERS.map((entry) => (
            <button
              key={entry.key}
              type="button"
              role="tab"
              aria-selected={filter === entry.key}
              onClick={() => {
                setFilter(entry.key);
                setShown(PAGE_SIZE);
              }}
              className={`min-h-[36px] whitespace-nowrap px-3 py-1.5 text-[12px] font-black uppercase tracking-wide transition-colors ${control(variant)} ${
                filter === entry.key ? "bg-slate-900 text-white" : "text-slate-500 hover:bg-slate-100"
              }`}
            >
              {entry.label} <span className="ml-1 opacity-70">{counts[entry.key] ?? 0}</span>
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className={`${surface(variant)} px-4 py-10 text-center text-sm text-slate-500`}>
          {query || filter !== "all" ? "No orders match this search." : emptyMessage}
        </div>
      ) : (
        <div className={surface(variant)}>
          <ul>
            {filtered.slice(0, shown).map((row) => (
              <OrderRow key={row.id} row={row} basePath={basePath} variant={variant} />
            ))}
          </ul>
          {filtered.length > shown ? (
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
  const { variant, basePath, newOrderHref, tabs, summary, needsAction, myOrders, allOrders, adminTools } = props;
  const [tab, setTab] = useState<DirectOrderWorkspaceTabKey>(
    tabs.includes(props.initialTab) ? props.initialTab : "overview",
  );
  const [ordersFilter, setOrdersFilter] = useState<DirectOrderOrdersFilterKey>("mine");
  // An own-scope viewer has no wider set to switch to, so their filter is pinned to "mine" and the
  // strip is not rendered — rather than offering a control with one working position.
  const ordersRows =
    props.canSeeAllOrders && ordersFilter === "all" ? allOrders : myOrders;

  // The desks are partitioned by the QUESTION they answer, matched on their route. Grouping here
  // rather than in the nav registry keeps this component the only place that knows the new IA,
  // so the registry stays a plain list of pages and nothing else has to learn the grouping.
  const pharmacyControlTools = adminTools.filter((tool) => PHARMACY_CONTROL_DESKS.some((slug) => tool.href.includes(slug)));
  const reportTools = adminTools.filter((tool) => REPORT_DESKS.some((slug) => tool.href.includes(slug)));
  const controlTools = adminTools.filter((tool) => CONTROL_DESKS.some((slug) => tool.href.includes(slug)));

  const goNeedsAction = () => setTab("needs-action");

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
          <div className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 p-3 backdrop-blur sm:hidden">
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
      <div className="-mx-1 overflow-x-auto px-1">
        <div className={`inline-flex min-w-max border border-slate-300 bg-white p-1 ${control(variant)}`} role="tablist">
          {tabs.map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={`min-h-[40px] whitespace-nowrap px-3 py-1.5 text-[12px] font-black uppercase tracking-wide transition-colors ${control(variant)} ${
                tab === key ? "bg-slate-900 text-white" : "text-slate-500 hover:bg-slate-100"
              }`}
            >
              {TAB_LABEL[key]}
              {key === "needs-action" && summary.needsMyAction > 0 ? (
                <span className="ml-1.5 inline-flex min-w-[18px] justify-center rounded-full bg-orange-600 px-1 text-[10px] text-white">
                  {summary.needsMyAction}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </div>
      {props.reportHref ? (
        <Link
          href={props.reportHref}
          className="inline-flex min-h-[40px] items-center gap-1.5 px-2 text-[12px] font-black uppercase tracking-wide text-slate-500 hover:text-orange-700"
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
          />
          <section className={surface(variant)}>
            <header className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
              <h3 className="text-sm font-black text-slate-950">Recent orders</h3>
              {/* min-h-[44px] and -my-2 so the tap target reaches the floor without pushing the
                  header taller. Measured at 375x812 before the fix: 17px, the only control in the
                  workspace under 40. */}
              <button
                type="button"
                onClick={() => setTab("orders")}
                className="-my-2 inline-flex min-h-[44px] items-center px-2 text-[11px] font-black text-orange-700"
              >
                See all
              </button>
            </header>
            {myOrders.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-slate-500">You have not raised a direct order yet.</p>
            ) : (
              <ul>
                {myOrders.slice(0, 5).map((row) => (
                  <OrderRow key={row.id} row={row} basePath={basePath} variant={variant} />
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
        />
      ) : null}

      {/* ORDERS — one view, scope as a FILTER rather than as two tabs.
          Which orders a person may see is a permission question the server has already answered;
          making the user pick between "My Orders" and "All Orders" asked them to answer it again,
          in the module's own vocabulary. An own-scope viewer sees no filter strip at all, because
          for them the two sets are identical. */}
      {tab === "orders" ? (
        <div className="space-y-3">
          {props.canSeeAllOrders ? (
            <div className={`inline-flex min-w-max border border-slate-300 bg-white p-1 ${control(variant)}`} role="tablist">
              {ORDERS_FILTERS.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  role="tab"
                  aria-selected={ordersFilter === option.key}
                  onClick={() => setOrdersFilter(option.key)}
                  className={`min-h-[36px] px-3 text-[12px] font-black transition-colors ${
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
          />
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
        <p className="flex items-start gap-2 px-1 text-[11px] text-slate-500">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden="true" />
          An order waiting on pharmacy verification is in nobody&apos;s approval queue, and it expires 14 days after
          it was raised.
        </p>
      ) : null}
    </div>
  );
}
