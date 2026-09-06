import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { MarketAwarenessWorkspace } from "@/components/market-awareness/market-awareness-workspace";
import { assertMarketAwarenessPortalAccess } from "@/lib/market-awareness/page-guard";
import { canCreateActivity } from "@/lib/market-awareness/scope";

export const dynamic = "force-dynamic";

export default async function EmployeePortalMarketAwarenessPage() {
  const access = await assertMarketAwarenessPortalAccess();

  return (
    <EmployeePortalPageShell
      badge="Marketing"
      description="Raise a conference, round table, symposium or speaker programme against your products in one brick, and watch what that brick and its area sell afterwards."
      title="Market Awareness"
    >
      {/*
        `canCreate` is UX only — it decides whether the button is drawn. The route re-checks it on
        every POST, because a hidden button is not access control.
      */}
      <MarketAwarenessWorkspace canCreate={canCreateActivity(access)} />
    </EmployeePortalPageShell>
  );
}
