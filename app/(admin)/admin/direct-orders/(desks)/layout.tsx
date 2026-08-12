import { DirectOrdersDeskShell } from "@/components/direct-orders/workspace/direct-orders-desk-shell";
import { resolveDirectOrderWorkspaceTabs } from "@/lib/direct-orders/workspace-data";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

/**
 * The persistent frame around the ten Direct Orders desks.
 *
 * A ROUTE GROUP, not a path segment: `(desks)` never appears in a URL, so
 * `/admin/direct-orders/validations` and its nine siblings are exactly where they were and not one
 * link, redirect or test had to change. What it buys is precision — this layout wraps the desks and
 * ONLY the desks, leaving `/new` and `/[id]` alone. Those are focused single-purpose screens that a
 * tab strip would clutter, and `/[id]` already has its own return-to-your-list Back link.
 *
 * WHY A LAYOUT RATHER THAN A COMPONENT EACH PAGE RENDERS. A layout does not remount when you move
 * between its children, so the strip is genuinely persistent as a Super Admin moves from the
 * validation queue to the held lane — which is one job done in two places. Ten pages each rendering
 * their own copy would remount it ten times and, worse, be ten places to forget.
 *
 * CHEAP ON PURPOSE. `resolveDirectOrderWorkspaceTabs` is pure capability resolution — no queries.
 * Calling `loadDirectOrderWorkspaceView` here instead would have run four counts and built the
 * Needs Action inbox on every desk page, to draw six buttons.
 *
 * NO ACCESS GATE HERE. Each desk already asserts its own, and several are narrower than any check
 * this layout could make — the Held Desk and Approval Exceptions are Super-Admin-only while the
 * report is not. A gate here would either duplicate those rules or weaken them, and a layout that
 * looks like it authorises but does not is worse than one that plainly does not.
 */
export default async function DirectOrdersDeskLayout({ children }: { children: React.ReactNode }) {
  const access = await resolveAccessContextFromPage();
  const tabs = resolveDirectOrderWorkspaceTabs(access);
  return (
    <DirectOrdersDeskShell tabs={tabs} basePath="/admin/direct-orders">
      {children}
    </DirectOrdersDeskShell>
  );
}
