import { redirect } from "next/navigation";

import {
  pageHeaderDescriptionClassName,
  pageHeaderKickerClassName,
  pageHeaderRailClassName,
  pageHeaderRuleClassName,
  pageHeaderTitleClassName,
} from "@/components/admin/admin-design-tokens";
import { MarketAwarenessInbox } from "@/components/market-awareness/market-awareness-inbox";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

/**
 * Market Awareness approvals — the admin-shell door to the SAME inbox the portal serves.
 *
 * WHY THIS PAGE EXISTS. `resolveNavigationMode` pins the CEO to the admin shell, and the Super Admin
 * is an admin-shell role too, so `/employee-portals/market-awareness/inbox` bounced both of them
 * away. That page held the only Approve / Return / Reject buttons in the module, and the admin
 * Market Awareness page carries the workspace and nothing else — so when an activity cleared the
 * approval group and reached the CEO, the one person who had to answer it had no screen on which to
 * do so. Four activities were sitting at the CEO step with no way to move them when this was found.
 *
 * Same component as the portal, so the two shells cannot drift into two different sets of buttons;
 * only the frame around it differs. The gate is INLINE for the same reason the sibling pages' are:
 * a nav entry's `permission` mirrors what the page itself enforces, and the guard that keeps the two
 * honest reads this file.
 *
 * `read` is the gate, not `approve`. The queue is narrowed server-side to the caller's own
 * decisions (`canDecideStep`), so a role that can read and holds no decision sees an empty queue
 * rather than a refusal — and every decision is re-checked by the route on the POST.
 */
export default async function AdminMarketAwarenessInboxPage() {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals/market-awareness/inbox");
  }
  if (!(await canAccess(access, "market_awareness", "read"))) {
    redirect("/overview");
  }

  // Only the CEO step may approve at an amended amount, so only he is offered the field. The route
  // enforces the same thing — this decides whether the input is drawn, never whether it is allowed.
  const isCeoStepHolder = access.role === "CEO" || access.role === "Super Admin";

  return (
    <div className="space-y-6 p-6 sm:p-8">
      <div className="relative pb-4">
        <span aria-hidden="true" className={`absolute inset-x-0 bottom-0 ${pageHeaderRuleClassName}`} />
        <div className="relative min-w-0 space-y-1.5 pl-3.5">
          <span aria-hidden="true" className={pageHeaderRailClassName} />
          <p className={pageHeaderKickerClassName}>Approvals</p>
          <h1 className={pageHeaderTitleClassName}>Awareness Approvals</h1>
          <p className={pageHeaderDescriptionClassName}>
            Every awareness activity you are allowed to see. Approve, return for changes, hold or reject
            appear only where the decision is yours; History lists every activity you can see that has been
            answered.
          </p>
        </div>
      </div>

      <MarketAwarenessInbox isCeoStepHolder={isCeoStepHolder} />
    </div>
  );
}
