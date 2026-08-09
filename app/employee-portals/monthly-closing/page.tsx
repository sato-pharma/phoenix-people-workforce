import { redirect } from "next/navigation";

import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { PortalMonthlyClosingView } from "@/components/sales/portal-monthly-closing-view";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  canAccessPortalClosing,
  loadPortalMonthlyClosing,
} from "@/lib/sales/monthly-closing-portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Portal mount of the admin /sales/monthly-closing Closing Matrix + Details, scoped per viewer and
// PUBLISHED-gated (owner decision 2026-07-30). Every field-sales management role reaches their OWN
// closing here — never through an /admin URL. Access is enforced server-side three ways: the portal
// role gate (canAccessPortalClosing), assertPermission(sales, read), and the per-viewer scope inside
// loadPortalMonthlyClosing (line/region/area/product narrowing + confidential-column strip). A month
// only appears once the admin has published that (line, period).
export default async function PortalMonthlyClosingPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) redirect("/login");
  if (!canAccessPortalClosing(access)) redirect(resolveLandingPathForRole(access.role));
  await assertPermission(access, "sales", "read");

  const params = await searchParams;
  const first = (value: string | string[] | undefined) =>
    typeof value === "string" ? value : Array.isArray(value) ? value[0] : null;
  const period = first(params.period);
  // Almost every viewer holds exactly one line and never sends this. It exists for the manager who
  // legitimately covers more than one (a Product Manager carrying a line_scope_override). The loader
  // refuses any line outside that viewer's own scope, so this is a selection, never a widening.
  const line = first(params.line);

  let result: Awaited<ReturnType<typeof loadPortalMonthlyClosing>> | null = null;
  let loadError: string | null = null;
  try {
    result = await loadPortalMonthlyClosing({ access, line, period });
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Failed to load Monthly Closing.";
  }

  const description =
    "Published monthly closing for your line — sales vs target by area and region, rolled up to a national total, with the invoice detail behind it. Scoped to your own areas.";

  return (
    <EmployeePortalPageShell
      badge="Sales Operations"
      description={description}
      errorBoundaryTitle="Monthly Closing unavailable"
      title="Monthly Closing"
    >
      {loadError || !result ? (
        <EmployeePortalEmptyState
          message={loadError ?? "Monthly Closing is unavailable right now — refresh to try again."}
          title="Monthly Closing unavailable"
        />
      ) : !result.line ? (
        <EmployeePortalEmptyState
          message="We couldn't resolve a product line for your account, so there is no closing to show. Ask HR to confirm your line assignment."
          title="No line on file"
        />
      ) : result.awaitingPublish || result.availablePeriods.length === 0 || !result.matrix ? (
        <EmployeePortalEmptyState
          message={
            // A viewer who covers several lines needs to know the OTHER ones are still there — an
            // unpublished line must not read as "you have no closing at all". Reached only by asking
            // for a specific line, since with no `?line=` the loader already prefers a published one,
            // and the picker only ever offers published lines — so there is no control to point at
            // here, just the fact that the other line is waiting.
            result.availableLines.length > 0
              ? `No month has been published for ${result.line} yet. Already published for you: ${result.availableLines.join(", ")}.`
              : `No month has been published for ${result.line} yet. Your monthly closing will appear here once it is published.`
          }
          title="Awaiting publish"
        />
      ) : (
        <PortalMonthlyClosingView
          availableLines={result.availableLines}
          availablePeriods={result.availablePeriods}
          line={result.line}
          matrix={result.matrix}
          selectedPeriod={result.selectedPeriod}
        />
      )}
    </EmployeePortalPageShell>
  );
}
