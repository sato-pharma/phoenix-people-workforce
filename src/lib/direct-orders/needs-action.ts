import { describeDirectOrderBasketUnits, type DirectOrderBasketLine } from "@/lib/direct-orders/basket-label";
import { describeDirectOrderStatus } from "@/lib/direct-orders/status-labels";

// ─────────────────────────────────────────────────────────────────────────────
// The Needs Action inbox — one question ("what is waiting on ME?") answered once,
// instead of five pages a person has to already know about.
//
// WHY: the five things a direct order can be waiting on today live on five
// different routes. An approver looks at /…/approvals/direct-orders. A requester
// whose order came back finds it under "My direct orders" with no prompt at all.
// A held order's verification door is on the ORDER page, reachable only if you
// already opened the order. Pending customer validations are a Super-Admin-only
// desk at /admin/direct-orders/validations. Orders waiting for a Finance month
// are visible only as a sidebar badge count. Nothing anywhere says "these five
// things are yours".
//
// THIS FILE IS PURE. It takes lists the existing services already return and
// groups them; it opens no connection, reads no session, and enforces nothing.
// Every scope decision was already made upstream by the service that produced
// the list — `getDirectOrderWorkspaceData` filters `awaiting` through
// `viewerCanActOnStep`, `listMyDirectOrders` filters to the caller's own HR ID,
// and the Finance queue is gated by `canSetDirectOrderSalesMonth`. Re-deriving
// any of that here would be a second copy of a visibility rule, which is exactly
// how `reverse` became reachable by every rep in the company (audit F5).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The narrow row this file works on.
 *
 * Deliberately NOT `DirectOrderApprovalListItem`: the Finance queue is built from
 * `DirectOrderReportRow`, which carries a different (wider) set of fields, and the
 * queue only ever needs these few. Both existing row types satisfy this
 * structurally, so neither has to be converted into the other — and a test can
 * build one by hand without standing up either.
 */
export type DirectOrderQueueRow = {
  id: string;
  requesterName: string;
  /** Every product joined with " + " on a basket; line 1's name on a one-product order. */
  productName: string;
  /**
   * The one product's units; NULL on a basket. Never a sum — units of different products are never
   * added (owner rule). A basket's units are each line's own, in `items`.
   */
  qty: number | null;
  /**
   * One entry per product. A row's `salesValue` is the WHOLE basket, so naming only line 1 shows
   * one product's name against two products' money — see @/lib/direct-orders/basket-label.
   * Optional because a hand-built test row need not supply it.
   */
  items?: readonly DirectOrderBasketLine[];
  pharmacyName: string;
  /**
   * Two pharmacies can share a name. The retired portal approvals card carried this for exactly
   * that reason ("an approver on a phone could not tell two same-named pharmacies apart" —
   * tests/direct-orders-approval-detail-names.test.ts), so it rides the consolidated row too.
   * Optional because DirectOrderReportRow supplies it and DirectOrderApprovalListItem does too,
   * but a hand-built test row need not.
   */
  pharmacyCode?: string;
  /** Same provenance: the retired portal card showed the covering rep. Absent on report rows. */
  medicalRepName?: string;
  areaName: string;
  regionName: string;
  salesValue: number;
  createdAt: string;
  status: string;
  salesMonth: string | null;
  /** True when the bonus/discount exceeds its product cap — flagged for the reader, never blocking. */
  bonusOverCap: boolean;
};

// NOTE: there is deliberately no "finish_draft" kind — see the comment where the drafts group used
// to be built. `draft` is a DB column default that no user-facing path can produce.
export type DirectOrderNeedsActionKind =
  | "approve"
  | "correct"
  | "verify_customer"
  | "decide_customer"
  | "assign_month";

export type DirectOrderNeedsActionItem = {
  id: string;
  /** What the row says on its first line. A person and a product, never an id. */
  title: string;
  /** The second line: pharmacy, area, value. */
  subtitle: string;
  salesValue: number;
  createdAt: string;
  /** Where clicking the row goes. Always a specific record, never a list. */
  href: string;
  /** True when the bonus/discount exceeds its product cap — flagged, never blocking. */
  flagged: boolean;
};

export type DirectOrderNeedsActionGroup = {
  kind: DirectOrderNeedsActionKind;
  /** Written as a sentence about the reader: "4 orders waiting for your approval". */
  headline: string;
  /** What the button on each row says. Imperative, matches the action they will actually take. */
  actionLabel: string;
  count: number;
  /** Total value in the group. Approvers prioritise by money, so the card carries it. */
  totalValue: number;
  items: DirectOrderNeedsActionItem[];
  /** Where "see all" goes when the group is longer than the inbox shows. */
  seeAllHref: string;
};

const money = (value: number) => `${Math.round(value).toLocaleString("en-US")} EGP`;

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

function toItem(row: DirectOrderQueueRow, basePath: string): DirectOrderNeedsActionItem {
  const area = row.areaName || row.regionName || "";
  // Pharmacy NAME then CODE, because two pharmacies can share a name and the code is what tells
  // them apart; then the covering rep where we have one; then the money.
  const pharmacy = row.pharmacyCode ? `${row.pharmacyName} (${row.pharmacyCode})` : row.pharmacyName;
  const subtitleParts = [pharmacy, area, row.medicalRepName, money(row.salesValue)].filter(Boolean);
  return {
    id: row.id,
    // Each product with its own units — a basket has no single quantity to print.
    title: `${row.requesterName} · ${describeDirectOrderBasketUnits(row, row.items)}`,
    subtitle: subtitleParts.join(" · "),
    salesValue: row.salesValue,
    createdAt: row.createdAt,
    href: `${basePath}/${encodeURIComponent(row.id)}`,
    flagged: row.bonusOverCap,
  };
}

function group(
  kind: DirectOrderNeedsActionKind,
  headline: string,
  actionLabel: string,
  rows: DirectOrderQueueRow[],
  basePath: string,
  seeAllHref: string,
): DirectOrderNeedsActionGroup {
  return {
    kind,
    headline,
    actionLabel,
    count: rows.length,
    totalValue: rows.reduce((sum, row) => sum + row.salesValue, 0),
    items: rows.map((row) => toItem(row, basePath)),
    seeAllHref,
  };
}

export type DirectOrderNeedsActionInput = {
  /** Steps this viewer can decide right now — already filtered by viewerCanActOnStep. */
  awaitingMyApproval: readonly DirectOrderQueueRow[];
  /** The viewer's OWN orders, any status — from listMyDirectOrders. */
  myOrders: readonly DirectOrderQueueRow[];
  /**
   * Approved orders carrying no sales month. Pass an EMPTY list for a viewer who
   * cannot book a month: a queue nobody can clear is how people learn to ignore
   * queues, which is the same reason getDirectOrderUnbookedBadge returns 0 to
   * everyone but Finance and Super Admin.
   */
  awaitingFinanceMonth: readonly DirectOrderQueueRow[];
  /** Pending pharmacy validations this viewer may decide. 0 for everyone but Super Admin. */
  pendingCustomerValidations: number;
  /** Route prefix for this shell — "/admin/direct-orders" or "/employee-portals/direct-orders". */
  basePath: string;
};

/**
 * Build the inbox. Groups with nothing in them are omitted entirely rather than
 * rendered as a zero: an empty queue on screen still costs the reader a glance,
 * and the whole point of this surface is that everything on it is real work.
 */
export function buildDirectOrderNeedsAction(
  input: DirectOrderNeedsActionInput,
): DirectOrderNeedsActionGroup[] {
  const { basePath } = input;
  const groups: DirectOrderNeedsActionGroup[] = [];

  const approvals = [...input.awaitingMyApproval];
  if (approvals.length > 0) {
    groups.push(
      group(
        "approve",
        `${approvals.length} ${plural(approvals.length, "order is", "orders are")} waiting for your approval`,
        "Review",
        approvals,
        basePath,
        `${basePath}?view=needs-action&queue=approve`,
      ),
    );
  }

  // Split from the viewer's OWN orders — one already-fetched list, no extra query.
  const returned = input.myOrders.filter((row) => String(row.status) === "returned");
  if (returned.length > 0) {
    groups.push(
      group(
        "correct",
        `${returned.length} ${plural(returned.length, "order was", "orders were")} sent back to you for a correction`,
        "Fix and resubmit",
        returned,
        basePath,
        `${basePath}?view=needs-action&queue=correct`,
      ),
    );
  }

  const held = input.myOrders.filter((row) => String(row.status) === "held");
  if (held.length > 0) {
    groups.push(
      group(
        "verify_customer",
        `${held.length} of your ${plural(held.length, "order needs", "orders need")} the venue verified before anyone can approve it`,
        "Verify venue",
        held,
        basePath,
        `${basePath}?view=needs-action&queue=verify_customer`,
      ),
    );
  }

  // NO "finish draft" GROUP — `draft` is not a capability this product has (second-review
  // finding 2, verified 2026-08-11).
  //
  // `draft` is the DB column default (`status text not null default 'draft'`, foundation migration)
  // and a declared registry status, but NOTHING creates a draft row: `submitDirectOrder` is the only
  // write path into `direct_order_requests` and it always inserts `pending_approval` or `held`,
  // overwriting the default in the same statement. There is no save-draft control, no draft editor
  // and no submit-an-existing-draft path anywhere in the module.
  //
  // So the group this replaces offered a "Finish" button for a state a user cannot reach and could
  // not have acted on if they had — a fake capability, which is worse than an absent one. Removing
  // it hides nothing: a `draft` row (only reachable by direct SQL) still appears in the Orders list
  // like any other status, and `draft` is left untouched in the DB check constraint, the registry
  // and the status vocabulary. Implementing real drafts later means adding the missing write paths
  // and restoring this group — not re-deriving the state.

  const finance = [...input.awaitingFinanceMonth];
  if (finance.length > 0) {
    groups.push(
      group(
        "assign_month",
        `${finance.length} approved ${plural(finance.length, "order is", "orders are")} waiting for you to book a sales month`,
        "Assign month",
        finance,
        basePath,
        `${basePath}?view=needs-action&queue=assign_month`,
      ),
    );
  }

  if (input.pendingCustomerValidations > 0) {
    // Not an order queue — these are pharmacy claims, and they live on their own
    // desk because deciding one revives EVERY held order of that pharmacy. The
    // inbox surfaces the count and hands off; it does not restate the desk.
    groups.push({
      kind: "decide_customer",
      headline: `${input.pendingCustomerValidations} ${plural(
        input.pendingCustomerValidations,
        "venue is",
        "venues are",
      )} waiting for you to confirm they exist`,
      actionLabel: "Open validation desk",
      count: input.pendingCustomerValidations,
      totalValue: 0,
      items: [],
      seeAllHref: "/admin/direct-orders/validations",
    });
  }

  return groups;
}

/** Total number of things waiting on this viewer — the one number a badge should carry. */
export function countDirectOrderNeedsAction(groups: readonly DirectOrderNeedsActionGroup[]): number {
  return groups.reduce((sum, entry) => sum + entry.count, 0);
}

// ── Summary cards on the workspace landing ───────────────────────────────────

export type DirectOrderWorkspaceSummary = {
  needsMyAction: number;
  inProgress: number;
  returned: number;
  completedThisMonth: number;
};

/**
 * The four numbers on the landing page.
 *
 * `completedThisMonth` counts orders BOOKED into the current sales month, not
 * ones approved during it. Those are different figures and the second one is the
 * misleading one: CEO approval puts nothing in any month's numbers (the GOLDEN
 * RULE), so counting approvals would report money that has not been booked.
 */
export function buildDirectOrderWorkspaceSummary(input: {
  needsAction: readonly DirectOrderNeedsActionGroup[];
  scopedOrders: readonly DirectOrderQueueRow[];
  /** Current month as YYYY-MM. Passed in rather than read from a clock so this stays pure. */
  currentSalesMonth: string;
}): DirectOrderWorkspaceSummary {
  let inProgress = 0;
  let returned = 0;
  let completedThisMonth = 0;

  for (const row of input.scopedOrders) {
    const status = String(row.status);
    if (status === "returned") {
      returned += 1;
      continue;
    }
    const { stage } = describeDirectOrderStatus(status, row.salesMonth);
    if (stage === "approval" || stage === "customer_check" || stage === "finance") {
      inProgress += 1;
      continue;
    }
    if (stage === "completed" && row.salesMonth === input.currentSalesMonth) {
      completedThisMonth += 1;
    }
  }

  return {
    needsMyAction: countDirectOrderNeedsAction(input.needsAction),
    inProgress,
    returned,
    completedThisMonth,
  };
}
