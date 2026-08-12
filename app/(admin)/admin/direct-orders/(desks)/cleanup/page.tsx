import { redirect } from "next/navigation";
import { Sparkles } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { DirectOrderCleanupDesk } from "@/components/direct-orders/cleanup-desk";
import { getDirectOrderCleanupPlan } from "@/lib/direct-orders/service";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

/**
 * Duplicate cleanup, reviewed and confirmed by an SFE Manager (owner rule 5, 2026-08-09).
 *
 * The system finds one real pharmacy entered twice and one real order submitted twice, works out
 * exactly what to do about each, and shows it here with its reasoning. Nothing is written until the
 * reviewer confirms — and they may change any choice first.
 *
 * SFE Manager as well as Super Admin, deliberately: the owner put SFE in the reviewer's seat for
 * this work. The service enforces the gate; this redirect is only UX.
 */
export default async function DirectOrdersCleanupPage() {
  const access = await resolveAccessContextFromPage();
  if (!(access.scope === "system" || access.role === "Super Admin" || access.role === "SFE Manager")) {
    redirect("/admin/direct-orders");
  }
  const plan = await getDirectOrderCleanupPlan(access);
  return (
    <div className="space-y-5">
      <AdminPageHero
        eyebrow="Sales"
        title="Direct Orders — Duplicate Cleanup"
        description="One pharmacy entered twice, or one order submitted twice. The system finds them, works out what to do, and explains why. Nothing changes until you confirm."
        icon={<Sparkles className="h-3.5 w-3.5" />}
      />
      <DirectOrderCleanupDesk plan={plan} />
    </div>
  );
}
