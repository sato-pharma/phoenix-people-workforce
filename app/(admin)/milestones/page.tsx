import { redirect } from "next/navigation";

import { MilestonesWorkspace } from "@/components/milestones/milestones-workspace";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { assertPermission, canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { formatPlainDateIso, todayInCairo } from "@/lib/milestones/periods";
import { listMilestonesDue } from "@/lib/milestones/service";

export const dynamic = "force-dynamic";

/** How far ahead the page opens on. Long enough to plan a print, short enough to be a list. */
const WINDOW_DAYS = 30;

/**
 * Milestones — the service-anniversary workspace.
 *
 * SUPER ADMIN AND CEO ONLY. The gate below redirects rather than rendering a locked shell, and it
 * is NOT the security boundary: `/api/milestones/*` asserts the same permission on every call,
 * because a hidden page is UX and a route is the boundary.
 *
 * The first window is resolved on the server so the first paint already lists who is coming up —
 * the whole point of the page is that a first month is easy to miss.
 */
export default async function MilestonesPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect(resolveLandingPathForRole(access.role));
  }
  try {
    await assertPermission(access, "milestones", "read");
  } catch {
    redirect(resolveLandingPathForRole(access.role));
  }
  const canExport = await canAccess(access, "milestones", "export");

  const from = todayInCairo();
  const toMs = Date.UTC(from.year, from.month - 1, from.day) + WINDOW_DAYS * 86_400_000;
  const toDate = new Date(toMs);
  const to = {
    year: toDate.getUTCFullYear(),
    month: toDate.getUTCMonth() + 1,
    day: toDate.getUTCDate(),
  };

  const entries = await listMilestonesDue({ from, to });

  return (
    <MilestonesWorkspace
      canExport={canExport}
      initialEntries={entries}
      initialFrom={formatPlainDateIso(from)}
      initialTo={formatPlainDateIso(to)}
    />
  );
}
