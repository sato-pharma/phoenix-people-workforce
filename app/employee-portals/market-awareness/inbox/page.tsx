import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { MarketAwarenessInbox } from "@/components/market-awareness/market-awareness-inbox";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

/**
 * Market Awareness approvals — its own inbox under Approvals Hub, beside Marketing Inbox.
 *
 * The gate is INLINE, matching every other portal page: a nav entry's `permission` mirrors what the
 * page itself enforces, and the guard that keeps the two honest re-derives the truth by reading this
 * file, so a gate hidden in a helper reads as "this page enforces nothing".
 *
 * `read` is deliberately the gate, not `approve`. The queue is scoped server-side to the decisions
 * that are actually the caller's, so someone with read alone sees an empty queue rather than a
 * refusal — and the CEO, who holds approve, is admitted by the same check.
 */
export default async function EmployeePortalMarketAwarenessInboxPage() {
  const access = await resolveAccessContextFromPage();

  // The CEO and the Super Admin are admin-shell viewers, and every notification and Needs You link
  // for a decision names THIS address. Sending them to /overview left the one person the chain ends
  // with on a page that has no inbox — so they go to the admin twin, which holds the same buttons.
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/admin/market-awareness/inbox");
  }
  if (!(await canAccess(access, "market_awareness", "read"))) {
    redirect("/employee-portals");
  }

  // Only the CEO step may approve at an amended amount, so only he is offered the field. The route
  // enforces the same thing — this decides whether the input is drawn, never whether it is allowed.
  const isCeoStepHolder = access.role === "CEO" || access.role === "Super Admin";

  return (
    <EmployeePortalPageShell
      badge="Approvals"
      description="Every awareness activity you are allowed to see. Approve, return for changes, hold or reject appear only where the decision is yours; History lists every activity you can see that has been answered."
      title="Awareness Approvals"
    >
      <MarketAwarenessInbox isCeoStepHolder={isCeoStepHolder} />
    </EmployeePortalPageShell>
  );
}
