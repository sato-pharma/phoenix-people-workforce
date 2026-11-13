import { redirect } from "next/navigation";
import { PlugZap } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { IntegrationsBoardView } from "@/components/admin/integrations/integrations-board";
import { assertSystemAdministratorWorkspaceAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { loadIntegrationsBoard, type IntegrationsBoard } from "@/lib/integrations/status";

export const dynamic = "force-dynamic";

/**
 * /admin/integrations — every outside service Phoenix depends on: configured or not, last success, last
 * failure (integration audit, ISS-039 · INT-063). SUPER ADMIN ONLY: the guard runs before anything is read.
 * An expired session resolves to the anonymous guest, which goes to sign-in, not to a "not allowed" bounce.
 *
 * Read on the server for each visit. Nothing refreshes on a timer and no outside service is called.
 */
export default async function IntegrationsRoute() {
  const access = await resolveAccessContextFromPage();
  if (access.source === "guest" || (!access.loginId && !access.hrId)) redirect("/login");

  let allowed = true;
  try {
    assertSystemAdministratorWorkspaceAccess(access, "the Integrations page");
  } catch {
    allowed = false;
  }
  // redirect() throws by design, so it stays outside the try.
  if (!allowed) redirect("/admin");

  let board: IntegrationsBoard | null = null;
  let error: string | null = null;
  try {
    board = await loadIntegrationsBoard();
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "the source did not answer";
  }

  return (
    <div className="space-y-6">
      <AdminPageHero
        description="Every outside service Phoenix depends on: whether it is configured, and when it last worked and last failed. A credential's value is never shown."
        eyebrow="System · Super Admin"
        icon={<PlugZap className="h-3.5 w-3.5" />}
        title="Integrations"
      />
      <IntegrationsBoardView board={board} error={error} />
    </div>
  );
}
