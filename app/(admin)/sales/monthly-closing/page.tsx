import { redirect } from "next/navigation";

import { MonthlyClosingWorkspace } from "@/components/sales/monthly-closing-workspace";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { canExportConsolidatedClosing } from "@/lib/sales/closing-consolidated";
import { resolveClosingDeepLinkMiss } from "@/lib/sales/closing-deep-link";
import type { MonthlyClosingMatrix } from "@/lib/sales/monthly-distributor-import";
import { loadMonthlyClosingPartsWithStoreSplit } from "@/lib/sales/monthly-closing-with-store-split";
import { loadMonthlySourceCoverage, type MonthlySourceCoverage } from "@/lib/sales/source-coverage";

export const dynamic = "force-dynamic";

export default async function MonthlyClosingPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const access = await resolveAuthenticatedPageAccess();
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals/source-of-sales");
  }

  // The admin upload + publish workspace. Super Admin gets full read/write/publish. SFE Manager
  // gets view + download only (owner decision, 2026-08-05): he already holds sales:import for
  // Upload/Import Advanced and asked to see the matrix -- including pre-publish/draft state --
  // without ever being able to publish it himself. Everyone else still consumes the published
  // closing through the employee-portal Monthly Closing tab. Publish/unpublish stay hard-gated to
  // Super Admin independently in app/api/sales/monthly-closing/publish/route.ts's own
  // forbidNonAdmin check -- this check only controls page access and canPublish below, never the
  // publish action itself.
  const isSystemAdministratorViewer = access.role === "Super Admin" || access.scope === "system";
  // The CEO added 2026-09-07, on his own report that Monthly Closing did not appear for him and he
  // could not reach it. Both were true: no rail row carried this href for him and this guard sent
  // him away. He was offered the read-only analytics mount instead and refused it — he wants THIS
  // page. Read-only exactly like the SFE Manager carve-out above: canPublish below stays false for
  // him, so no publish, unpublish or lock control renders, and the workspace never calls their two
  // status feeds at all (it gates both fetches on canPublish). Publishing keeps its own
  // independent Super-Admin-only guard in the publish route, untouched.
  //
  // The SFE Manager term stays spelled exactly as it was and the CEO term is APPENDED:
  // tests/sfe-manager-nav-dead-links.test.ts pins this expression as a literal source substring.
  if (!isSystemAdministratorViewer && access.role !== "SFE Manager" && access.role !== "CEO") {
    redirect(resolveLandingPathForRole(access.role));
  }

  // Deep-linked from the closing-published email (see app/api/sales/monthly-closing/go/route.ts):
  // ?line=&period= pre-select which month opens, instead of always the default (latest) one. Absent
  // for a normal visit, which keeps today's default-to-latest behavior unchanged.
  const params = await searchParams;
  const requestedLine = typeof params.line === "string" ? params.line : Array.isArray(params.line) ? params.line[0] : null;
  const requestedPeriod = typeof params.period === "string" ? params.period : Array.isArray(params.period) ? params.period[0] : null;

  let initialMatrix: MonthlyClosingMatrix | null = null;
  // The Office-only grid behind every "of which Office" column. Null = could not be read.
  let initialOffice: MonthlyClosingMatrix | null = null;
  let initialCoverage: MonthlySourceCoverage | null = null;
  let initialError: string | null = null;

  try {
    // sales:import for everyone this page admits EXCEPT the CEO, who consumes this closing and must
    // never hold the upload/publish key (it gates /sales/upload, the mapping database and ten other
    // pages). The role gate above is the security boundary for this load; asserting import here
    // would 403 the very screen the carve-out exists to give him.
    await assertPermission(access, "sales", access.role === "CEO" ? "read" : "import");
    const parts = await loadMonthlyClosingPartsWithStoreSplit({ line: requestedLine, period: requestedPeriod });
    initialMatrix = parts.combined;
    initialOffice = parts.office;
    // Completeness ride-along; a coverage failure hides the banner, never the closing.
    initialCoverage = await loadMonthlySourceCoverage(initialMatrix.line, initialMatrix.period, access).catch(() => null);
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Failed to load Monthly Closing.";
  }

  // A ?line=/?period= the closing could not honour is NAMED on the page, never substituted in
  // silence: loadMonthlyClosingParts falls back to the newest month of the first line, which then
  // renders as an ordinary, complete closing for a month nobody asked to see. The client-side
  // picker already names a month it could not read; this is the same promise for the first,
  // server-rendered read. See src/lib/sales/closing-deep-link.ts.
  const deepLinkMiss = initialMatrix
    ? resolveClosingDeepLinkMiss({
        requestedLine,
        requestedPeriod,
        resolvedLine: initialMatrix.line,
        resolvedPeriod: initialMatrix.period,
      })
    : null;

  return (
    <MonthlyClosingWorkspace
      // Several months added together into one download: Super Admin and the CEO only (owner,
      // 2026-09-14). The two consolidated routes refuse everyone else on their own.
      canExportConsolidated={canExportConsolidatedClosing(access.role)}
      canPublish={isSystemAdministratorViewer}
      initialCoverage={initialCoverage}
      initialDeepLinkMiss={deepLinkMiss}
      initialError={initialError}
      initialMatrix={initialMatrix}
      initialOffice={initialOffice}
    />
  );
}
