import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { adminSidebarDomains } from "@/config/sidebar-domains.ts";
import { adminNavigationSections } from "@/config/system-navigation.ts";
import { accessRegistry } from "@/lib/security/access-registry.ts";

import { stripComments } from "./support/comment-strip.ts";

/**
 * THE THREE QUEUES THAT LEFT "OTHER APPROVALS", AND THE ONE THING THE BOARD MAY NOT LOSE.
 *
 * Owner, 2026-10-08, three instructions in one message: *"separate the disputes inbox into a
 * separate dispute inbox"*, *"since I have the expense approvals outside in a separate mailbox,
 * don't show any related expense approvals in the Other Approvals"*, and *"the direct orders, why do
 * I see direct orders here? make a separate inbox for the direct orders"*.
 *
 * Four things can silently undo that, and each one is a real defect rather than a tidiness issue:
 *
 *   1. THE BADGE COUNTING WHAT THE PAGE NO LONGER SHOWS. A number over an empty inbox is the
 *      "queue nobody could read" failure the hub's own comments were written about — in reverse.
 *      The exclusion therefore has to sit where BOTH the list and the count pass through it.
 *   2. THE NEEDS YOU BOARD LOSING THE QUEUE ALTOGETHER. `src/lib/needs-you/sources.ts` reads the
 *      same aggregator, and that board may never under-report (docs/needs-you.md): a waiting expense
 *      claim must still be on it. So the filter must NOT be inside
 *      getAwaitingMyActionItemsWithHealth — only the board's destination may change.
 *   3. A DEAD NOTIFICATION LINK. Every review-request notice already sent carries
 *      ?tab=disputes on the hub, and that tab no longer exists.
 *   4. A SEPARATE INBOX NOTHING POINTS AT. A page with no sidebar row and no pending badge is a
 *      screen he has to remember to open, which is exactly why the board row exists.
 */
export function runApprovalsHubSeparateInboxesTests() {
  const read = (path: string) => stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
  const bodyOf = (source: string, signature: string, file: string) => {
    const start = source.indexOf(signature);
    assert.ok(start >= 0, `${signature} not found in ${file}`);
    const end = source.indexOf("\n}\n", start);
    return source.slice(start, end < 0 ? undefined : end);
  };

  const ACTION = "src/lib/action-center/service.ts";
  const NEEDS_YOU = "src/lib/needs-you/sources.ts";
  const HUB_PAGE = "app/(admin)/admin/approvals-hub/page.tsx";
  const DISPUTES_PAGE = "app/(admin)/admin/private-calendar-disputes/page.tsx";
  const action = read(ACTION);
  const needsYou = read(NEEDS_YOU);
  const hubPage = read(HUB_PAGE);
  const disputesPage = read(DISPUTES_PAGE);

  // ── 1. Expenses are out of the inbox AND out of its badge ───────────────────
  assert.match(
    action,
    /OTHER_APPROVALS_MOVED_OUT[\s\S]{0,200}outstation: "\/admin\/outstation\/expense-approvals"/,
    "outstation must be declared as moved out, with the mailbox it moved to",
  );
  const list = bodyOf(action, "export async function getAwaitingMyActionItems(", ACTION);
  assert.match(
    list,
    /belongsInOtherApprovalsInbox/,
    "the hub's inbox list must drop the modules that moved to their own mailbox",
  );
  const count = bodyOf(action, "export async function countAwaitingMyActionItems(", ACTION);
  assert.match(
    count,
    /belongsInOtherApprovalsInbox\(item\)/,
    "RED the sidebar badge must apply the SAME exclusion as the list, or it puts a count over an inbox with no such row",
  );

  // ── 2. The Needs You board keeps the queue, and only changes where it points ─
  const withHealth = bodyOf(action, "export async function getAwaitingMyActionItemsWithHealth(", ACTION);
  assert.doesNotMatch(
    withHealth,
    /belongsInOtherApprovalsInbox|OTHER_APPROVALS_MOVED_OUT/,
    "RED the exclusion must NOT live in getAwaitingMyActionItemsWithHealth — src/lib/needs-you/sources.ts reads it, and that board may never under-report a waiting approval",
  );
  assert.match(
    needsYou,
    /href: OTHER_APPROVALS_MOVED_OUT\[module\] \?\? needsYouDestinations\["action-inbox"\]\.href/,
    "a moved-out module's board row must link to its own mailbox, not to the inbox that no longer lists it",
  );

  // ── 3. Every link already in the wild still lands on the decision ───────────
  assert.match(
    hubPage,
    /params\.tab === "disputes"[\s\S]{0,120}redirect\("\/admin\/private-calendar-disputes"\)/,
    "RED ?tab=disputes must bounce to the Calendar Disputes inbox — every review-request notification sent so far carries that query",
  );
  assert.match(
    hubPage,
    /outstation: "\/admin\/outstation\/expense-approvals"/,
    "an ?module=outstation deep link must bounce to the expense mailbox rather than re-injecting the claim here",
  );
  // "Where did it go?" is answered on the page itself — and only with mailboxes this viewer can
  // open, because a link that bounces the reader straight back out is worse than no link.
  assert.match(
    hubPage,
    /movedOutQueues=\{movedOutQueues\}/,
    "the hub must name where the moved-out queues live",
  );
  assert.match(
    hubPage,
    /canReviewOutstationExpenseApprovals\(access\)[\s\S]{0,160}expense-approvals/,
    "the expense link must be gated on the expense desk's own grant",
  );
  assert.match(
    hubPage,
    /access\.role === "Super Admin"[\s\S]{0,160}private-calendar-disputes/,
    "the Calendar Disputes link must be shown only to the one role that can decide a review request",
  );
  // These three links are CAPABILITY FLAGS, not this page's entry gate. Written as
  // `assertPermission(...).then(() => true).catch(() => false)` the direct-orders one read to
  // tests/support/page-gate-reader.ts as the page DEMANDING direct_orders:read, and
  // every-offered-link-opens then named three seats — Financial Advisor, HR Advisory, HR Operations
  // — whose "Other Approvals" row it said would bounce them on arrival.
  assert.doesNotMatch(
    hubPage,
    /await assertPermission\(/,
    "RED an assertPermission in this page is read as its own entry gate — a flag for one link must use canAccess",
  );
  assert.match(
    hubPage,
    /const canReadDirectOrders = await canAccess\(access, "direct_orders", "read"\)/,
    "the direct-orders link reads the grant with canAccess, which is the shape that reader treats as a flag",
  );

  for (const source of [
    "src/lib/private-calendar/disputes.ts",
    "src/lib/private-calendar/dispute-messages.ts",
    "src/lib/needs-you/types.ts",
  ]) {
    const text = read(source);
    assert.doesNotMatch(
      text,
      /approvals-hub\?tab=disputes/,
      `${source} still sends a reader to the retired hub tab`,
    );
    assert.match(text, /\/admin\/private-calendar-disputes/, `${source} must point at the Calendar Disputes inbox`);
  }

  // ── 4. The separate inbox is a real page, reachable, and badged ─────────────
  assert.doesNotMatch(
    disputesPage,
    /redirect\("\/admin\/approvals-hub\?tab=disputes"\)/,
    "RED the Calendar Disputes page must render the inbox, not redirect back into the hub tab it replaced",
  );
  assert.match(
    disputesPage,
    /PrivateCalendarDisputesWorkspace/,
    "the Calendar Disputes page must mount the reviewer's workspace",
  );
  assert.match(
    disputesPage,
    /attachDisputeContext/,
    "RED the page must attach each request's context — who the employee is, who they report to, and what Phoenix already holds for the disputed day. Without it the inbox is three bare strings again, which is the state the owner could not read",
  );

  const approvals = adminNavigationSections.find((section) => section.id === "approvals-hub");
  assert.ok(approvals, "the admin rail must still have an Approvals section");
  const disputeRow = approvals.items.find((item) => item.href === "/admin/private-calendar-disputes");
  assert.ok(disputeRow, "RED the Calendar Disputes inbox needs its own row in the admin Approvals section");
  assert.equal(
    disputeRow.navBadge,
    "calendar-disputes-pending",
    "the row must carry its own pending badge — the hub's count has never covered a review request",
  );
  assert.deepEqual(
    disputeRow.roles,
    ["Super Admin"],
    "deciding a review request is Super Admin only end to end (assertDisputeDecisionActor), so no other role may be shown the row",
  );

  const navBadge = read("src/components/layout/nav-badge.tsx");
  assert.match(
    navBadge,
    /case "calendar-disputes-pending":[\s\S]{0,200}src="\/api\/private-calendar\/disputes\/pending-count"/,
    "the one navBadge switch must map the new kind to its endpoint, or the row renders with no badge at all",
  );
  assert.match(
    read("src/lib/nav-badge-store.ts"),
    /"\/api\/private-calendar\/disputes\/pending-count": "calendarDisputes"/,
    "the badge must ride the one batched poll rather than opening a separate 30s request",
  );
  assert.match(
    read("src/lib/approvals-hub/badge-counts-payload.ts"),
    /calendarDisputes:/,
    "the batched endpoint must answer the calendarDisputes slot it is now asked for",
  );
  assert.ok(
    accessRegistry.some((entry) => entry.pattern === "/api/private-calendar/disputes/pending-count"),
    "every route under app/api needs an access-registry declaration or the required validate job goes red",
  );

  // ── 5. ONE ORANGE "APPROVALS" TAB, AND EVERY INBOX A ROW UNDER IT ──────────
  //
  // The owner, 2026-10-08, in three messages: *"in the sidebar show Approvals Hub as a title and
  // under it every tab in the approvals"*; *"the Approvals Hub is the orange because it is the title
  // and the separate sidebar tab, and under it all the approvals inboxes — so the Disputes inbox is
  // a separate inbox like Marketing Inbox, like Deduction Disputes, like anything"*; and finally
  // *"make every approval inbox its own row under the orange Approvals tab"*.
  //
  // What can silently undo it, and why each is a defect rather than a tidiness point:
  //
  //   - THE BAND SLIDING BACK UNDER ANOTHER DOMAIN. It was a group inside "Requests", which is
  //     where he could not find it: one accordion deeper than the requests he submitted himself.
  //     "Approvals" is its own door now, and a section id lives in exactly one group — so folding
  //     it back in is a one-line edit with no error anywhere.
  //   - A QUEUE DRIFTING BACK TO ITS MODULE. Four moved in (expenses, direct orders, marketing,
  //     awareness) and two were born here (calendar and deduction disputes). Each one came from a
  //     band where it was findable only by knowing which module owned it.
  //   - A SECOND ROW FOR THE SAME QUEUE. A copy rather than a move leaves two rows polling one
  //     badge endpoint, printing the same number twice in one rail.
  const approvalsDomain = adminSidebarDomains.find((domain) => domain.id === "approvals");
  assert.ok(
    approvalsDomain,
    `RED Approvals must be its own top-level sidebar domain, not a band inside another one — found: ${adminSidebarDomains.map((domain) => domain.id).join(", ")}`,
  );
  assert.deepEqual(
    approvalsDomain.groups.map((group) => group.sectionIds).flat(),
    ["approvals-hub"],
    "the Approvals domain holds exactly the approvals-hub section — a second id here would draw rows nobody asked to be under this tab",
  );
  assert.equal(
    adminSidebarDomains.findIndex((domain) => domain.id === "approvals"),
    1,
    "RED the Approvals tab sits second, right after Overview: it is the door he opens most, and the rail renders these in array order",
  );
  // The ORANGE line is the domain NAME (text-phx-accent in sidebar.tsx); the heading under it is
  // dim grey caps. His words belong in the orange one — *"the Approvals Hub is the orange because it
  // is the title and the separate sidebar tab"* — and the heading must not repeat it, because
  // groupAdminSections blanks a heading that repeats a visible ROW label and never one that repeats
  // the domain name above it.
  assert.equal(
    approvalsDomain.name,
    "Approvals Hub",
    "RED the orange title is the domain name, and it carries his words",
  );
  assert.notEqual(
    approvalsDomain.groups[0]?.heading.trim().toLowerCase(),
    "approvals hub",
    "RED the grey heading must not reprint the orange title one line below it",
  );
  assert.ok(
    (approvalsDomain.groups[0]?.heading ?? "").trim().length > 0,
    "and it must not be blank either — assertion 3 of tests/sidebar-domains.test.ts refuses that",
  );
  assert.equal(
    approvals.label,
    "Approvals Hub",
    "the section label must carry the same text as the domain heading — it is what the FLAT rail prints, and the two are read as one name",
  );
  assert.ok(
    adminSidebarDomains.every((domain) => domain.id === "approvals" || !domain.groups.some((group) => group.sectionIds.includes("approvals-hub"))),
    "approvals-hub must appear in NO other domain — groupAdminSections consumes a section at its first match, so a second mention renders nothing and hides the mistake",
  );

  const APPROVAL_INBOX_ROWS = [
    "/admin/approvals/vacation",
    "/admin/approvals/excuse",
    "/admin/approvals/plan",
    "/admin/outstation/expense-approvals",
    "/admin/direct-orders?view=needs-action",
    "/admin/marketing-requests/inbox",
    "/admin/market-awareness/inbox",
    "/admin/approvals-hub",
    "/admin/disputes",
    "/admin/private-calendar-disputes",
    "/admin/deductions?tab=disputes",
  ];
  assert.deepEqual(
    approvals.items.map((item) => item.href),
    APPROVAL_INBOX_ROWS,
    "RED every approval inbox is one row under this tab, in this reading order",
  );
  for (const href of APPROVAL_INBOX_ROWS) {
    const elsewhere = adminNavigationSections
      .filter((section) => section.id !== "approvals-hub")
      .flatMap((section) => section.items)
      .filter((item) => item.href === href);
    assert.equal(
      elsewhere.length,
      0,
      `RED ${href} is still a row outside the Approvals tab as well — a move, never a copy, or one rail prints the same badge twice`,
    );
  }

  // ── 6. DEDUCTION DISPUTES — the one he named twice ──────────────────────────
  // *"don't forget the deduction disputes"*, then *"don't forget the uh, deductions disputes"*
  // again in the same message. It had no row anywhere: the only route to it was the deep link inside
  // a notification email, which is the gap he reported as "I receive a comment on a deduction and I
  // can never reach it".
  const deductionRow = approvals.items.find((item) => item.href === "/admin/deductions?tab=disputes");
  assert.ok(deductionRow, "the Deduction Disputes inbox needs its own row");
  assert.equal(
    deductionRow.navBadge,
    "deduction-disputes-pending",
    "it carries a pending badge like its neighbours — the hub count has never covered a deduction comment",
  );
  assert.deepEqual(
    deductionRow.roles,
    ["Super Admin", "CEO", "HR Operations"],
    "RED the row mirrors the deductions page VIEW_ROLES, not isDeductionsReadActor: the Finance Manager passes that helper but the owner revoked his screen on 2026-08-11, so a row would bounce him straight out",
  );
  assert.match(
    read("src/components/layout/nav-badge.tsx"),
    /case "deduction-disputes-pending":[\s\S]{0,200}src="\/api\/deductions\/disputes\/pending-count"/,
    "the one navBadge switch must map the new kind to its endpoint",
  );
  assert.match(
    read("src/lib/nav-badge-store.ts"),
    /"\/api\/deductions\/disputes\/pending-count": "deductionDisputes"/,
    "the badge must ride the one batched poll rather than opening a separate 30s request",
  );
  assert.match(
    read("src/lib/approvals-hub/badge-counts-payload.ts"),
    /deductionDisputes:/,
    "the batched endpoint must answer the deductionDisputes slot it is now asked for",
  );
  // The CALL, not the import. Pinning the bare name passed while the guard was replaced by
  // `void access` — the import line alone satisfied it, which is the shape of an assertion that
  // reads as coverage and is none.
  assert.match(
    read("app/api/deductions/disputes/pending-count/route.ts"),
    /assertDeductionsReadActor\(access\)/,
    "RED the count is a company-wide deductions read: deductions:read alone is held by seats that may see only their own line, and that one grant already leaked 69 employees' amounts once",
  );
  assert.match(
    read("src/lib/approvals-hub/badge-counts-payload.ts"),
    /assertDeductionsReadActor\(access\)/,
    "RED the batched poll must pass the same gate as the dedicated endpoint — it is the one every open tab actually calls",
  );
  assert.ok(
    accessRegistry.some((entry) => entry.pattern === "/api/deductions/disputes/pending-count"),
    "every route under app/api needs an access-registry declaration or the required validate job goes red",
  );
  // The count must mean "waiting on HR", not "has ever been commented on" — an answered thread that
  // kept counting would never clear, and a badge that cannot be cleared teaches the reader to
  // ignore every badge in the rail.
  const comments = read("src/lib/deductions/comments.ts");
  assert.match(
    comments,
    /export async function countOpenDeductionsDisputes\(/,
    "the deductions module owns its own count",
  );
  assert.match(
    bodyOf(comments, "export async function countOpenDeductionsDisputes(", "src/lib/deductions/comments.ts"),
    /isDeductionsDecisionActor/,
    "RED a thread HR already replied to is finished work — the count is the threads whose newest line came from the employee's side",
  );
}
