import { redirect } from "next/navigation";

import { ActionsWorkspace, type MovedOutQueue } from "@/components/action-center/actions-workspace";
import type { ActionHubData, ActionHubModule, HistoricalApprovalItem, MyRequestItem } from "@/components/action-center/types";
import {
  canAccess,
  canReviewOutstationExpenseApprovals,
  resolveNavigationMode,
} from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canAccessMarketingAdminPage } from "@/lib/marketing-requests/admin-page-access";
import { getMarketingInboxQueueLink } from "@/lib/marketing-requests/service";
import {
  getActionCenterDeepLinkItem,
  getAwaitingMyActionItems,
  getMyRequestItems,
  getMyApprovalHistory,
} from "@/lib/action-center/service";
import {
  DECIDED_FOR_ME_WINDOW_DAYS,
  getDecisionsMadeForMe,
  type DecidedForMeItem,
} from "@/lib/action-center/decided-for-me";

export const dynamic = "force-dynamic";

function preservedQuery(params: Record<string, string | string[] | undefined>) {
  const query = new URLSearchParams();
  for (const key of ["module", "id", "tab"]) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) query.set(key, value);
  }
  const text = query.toString();
  return text ? `?${text}` : "";
}

// Modules that left the "Other Approvals" inbox for a page of their own. A stale link (an old
// notification, a bookmarked history URL) that still points at one of them must never inject that
// request back into this inbox — bounce it to the dedicated page instead, so this hub only ever
// shows resignations and contract renewals.
//
// Vacation, excuse and weekly/monthly plans moved out first. OUTSTATION EXPENSES JOINED THEM ON
// 2026-10-08, on the owner's instruction — *"since I have the expense approvals outside in a
// separate mailbox, don't show any related expense approvals in the Other Approvals"*; the claim is
// decided at /admin/outstation/expense-approvals, which has been the real desk since 2026-08-08.
// The inbox half of that exclusion is OTHER_APPROVALS_MOVED_OUT in lib/action-center/service.ts, so
// the sidebar badge cannot disagree with the page; this map covers the deep links and the
// "My requests" / history tabs.
const MIGRATED_DEEPLINK_BASES: Record<string, string> = {
  leave: "/admin/approvals/vacation",
  excuse: "/admin/approvals/excuse",
  outstation: "/admin/outstation/expense-approvals",
  weekly_plan: "/admin/approvals/plan",
};

// Direct orders and payroll expenses are DECIDED in their own workspaces and never were rows in
// this inbox — but they still arrived in the read-only "My requests" and "Approval history" tabs,
// which is what the owner was looking at on 2026-10-08: *"the direct orders, why do I see direct
// orders here? make a separate inbox for the direct orders"*. Each has had its own inbox for
// months (/admin/direct-orders, /admin/outstation/expenses), so the record is read there.
// ActionsWorkspace names all three destinations under its tabs, so this is a move, not a loss.
const MODULES_WITH_THEIR_OWN_INBOX = new Set(["direct_order", "payroll_expense"]);

function belongsInThisHub(item: { module: string }) {
  return !MIGRATED_DEEPLINK_BASES[item.module] && !MODULES_WITH_THEIR_OWN_INBOX.has(item.module);
}

/**
 * The mailboxes this viewer can actually open, named under the tabs so "why is this here?" does not
 * simply become "where did it go?".
 *
 * Resolved against the viewer's own grants, never a flat list: each destination has its own gate
 * (the expense desk redirects to /admin/access, the disputes inbox is Super Admin only), and a link
 * that bounces the reader straight back out is worse than no link.
 */
async function movedOutQueuesFor(access: Awaited<ReturnType<typeof resolveAccessContextFromPage>>): Promise<MovedOutQueue[]> {
  // `canAccess`, never `assertPermission(...).catch(() => false)`. It is a CAPABILITY FLAG for one
  // link, and the second form reads to tests/support/page-gate-reader.ts as this PAGE's entry gate
  // — which reported /admin/approvals-hub as demanding direct_orders:read and so handed three seats
  // (Financial Advisor, HR Advisory, HR Operations) a sidebar row the reader said would bounce them.
  // `const x = await canAccess(...)` is the shape that reader deliberately does not count, and it is
  // what the rest of the codebase writes for a flag.
  const canReadDirectOrders = await canAccess(access, "direct_orders", "read");
  // Marketing keeps its own inbox (owner, 2026-11-03): the hub only says what is waiting there. Same
  // role set the inbox page itself admits, so the line never links to a page that bounces the reader.
  const marketingInbox =
    access.scope === "system" || canAccessMarketingAdminPage(access.role, { approvalInbox: true })
      ? await getMarketingInboxQueueLink(access, "/admin/marketing-requests/inbox")
      : null;
  return [
    ...(canReviewOutstationExpenseApprovals(access)
      ? [{ href: "/admin/outstation/expense-approvals", label: "Expense approvals" }]
      : []),
    ...(canReadDirectOrders ? [{ href: "/admin/direct-orders", label: "Direct orders" }] : []),
    ...(marketingInbox ? [marketingInbox] : []),
    ...(access.role === "Super Admin"
      ? [{ href: "/admin/private-calendar-disputes", label: "Calendar disputes" }]
      : []),
  ];
}

export default async function AdminApprovalsHubPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await resolveAccessContextFromPage();
  const params = await searchParams;
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect(`/employee-portals/approvals-hub${preservedQuery(params)}`);
  }

  const initialModule = (typeof params.module === "string" ? params.module : null) as ActionHubModule | null;
  const initialId = typeof params.id === "string" ? params.id : null;

  // Calendar disputes became their own inbox on 2026-10-08 (owner: *"separate the disputes inbox
  // into a separate dispute inbox"*). Every review-request notification already sent carries
  // ?tab=disputes, so the old link has to keep landing on the decision.
  if (typeof params.tab === "string" && params.tab === "disputes") {
    redirect("/admin/private-calendar-disputes");
  }

  // Migrated modules never render inside this hub — redirect to their dedicated page.
  if (initialModule && MIGRATED_DEEPLINK_BASES[initialModule]) {
    const base = MIGRATED_DEEPLINK_BASES[initialModule];
    // Outstation's desk takes no per-claim route, so a deep link lands on the queue itself.
    const perItem = initialModule !== "outstation";
    redirect(initialId && perItem ? `${base}/${encodeURIComponent(initialId)}` : base);
  }

  // Admin audience: the residual cross-module inbox. Marketing, market awareness, direct orders and
  // outstation expenses all keep their own queues. "My requests" and history resolve in parallel.
  const [baseItems, rawMyRequests, rawHistoricalItems, decidedForMe]: [
    Awaited<ReturnType<typeof getAwaitingMyActionItems>>,
    MyRequestItem[],
    HistoricalApprovalItem[],
    DecidedForMeItem[] | null,
  ] = await Promise.all([
    getAwaitingMyActionItems(access, "admin"),
    getMyRequestItems(access).catch((): MyRequestItem[] => []),
    getMyApprovalHistory(access).catch((): HistoricalApprovalItem[] => []),
    // Still never fatal to the page — but null, not []. An empty array claims "nothing was
    // decided for you", which is a confident lie when the lookup actually failed; null lets the
    // tab say "could not load" instead.
    getDecisionsMadeForMe(access).catch((): DecidedForMeItem[] | null => null),
  ]);
  const movedOutQueues = await movedOutQueuesFor(access);
  // Every module with a hub or workspace of its own carries its own "My Requests"/"History" there —
  // drop them here so one request never shows twice, and so this page answers for exactly the two
  // queues it still owns.
  const myRequests = rawMyRequests.filter(belongsInThisHub);
  const historicalItems = rawHistoricalItems.filter(belongsInThisHub);
  const items = [...baseItems];
  if (initialModule && initialId && !items.some((item) => item.id === initialId && item.module === initialModule)) {
    const linkedItem = await getActionCenterDeepLinkItem(access, initialModule, initialId);
    if (linkedItem) items.unshift(linkedItem);
  }

  const data: ActionHubData = {
    generatedAt: new Date().toISOString(),
    items,
  };

  // Approvers land on their inbox; pure requesters (empty inbox) land on "My requests".
  const initialTab: "inbox" | "mine" | "historical" =
    initialModule || initialId || items.length > 0 ? "inbox" : myRequests.length > 0 ? "mine" : "inbox";

  return (
    <ActionsWorkspace
      inboxData={data}
      myRequests={myRequests}
      historicalItems={historicalItems}
      initialModule={initialModule}
      initialId={initialId}
      callerRole={access.role}
      initialTab={initialTab}
      movedOutQueues={movedOutQueues}
      decidedForMe={decidedForMe}
      decidedForMeWindowDays={DECIDED_FOR_ME_WINDOW_DAYS}
    />
  );
}
