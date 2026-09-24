import { redirect } from "next/navigation";

import { MilestonesWorkspace } from "@/components/milestones/milestones-workspace";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { assertPermission, canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { formatPlainDateIso, todayInCairo } from "@/lib/milestones/periods";
import { listMilestoneCandidates, listMilestonesDue } from "@/lib/milestones/service";

export const dynamic = "force-dynamic";

/** How far ahead the page opens on. Long enough to plan a print, short enough to be a list. */
const WINDOW_DAYS = 30;

/**
 * Milestones — the service-anniversary workspace.
 *
 * SUPER ADMIN ONLY (the owner narrowed it from Super Admin and CEO on 2026-09-23). The gate below
 * redirects rather than rendering a locked shell, and it
 * is NOT the security boundary: `/api/milestones/*` asserts the same permission on every call,
 * because a hidden page is UX and a route is the boundary.
 *
 * The first window is resolved on the server so the first paint already lists who is coming up —
 * the whole point of the page is that a first month is easy to miss.
 */
/** One value off the query string, or null — an array (`?x=a&x=b`) is not a deep link. */
function firstParam(value: string | string[] | undefined): string | null {
  if (typeof value === "string") return value.trim() || null;
  return null;
}

export default async function MilestonesPage({
  searchParams,
}: {
  // Next 15 hands search params in as a promise.
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
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

  // Both in one pass. The roster is what the name box searches, so it has to be there on the first
  // paint — a picker that fills in a second read as broken for that second, and the owner types
  // into it immediately.
  const [entries, candidates, params] = await Promise.all([
    listMilestonesDue({ from, to }),
    listMilestoneCandidates(),
    searchParams,
  ]);

  // A calendar chip links here with the person and the period already chosen.
  const initialHrId = firstParam(params.hrId);
  const initialPeriod = firstParam(params.period);

  return (
    <MilestonesWorkspace
      canExport={canExport}
      candidates={candidates}
      initialEntries={entries}
      initialFrom={formatPlainDateIso(from)}
      initialHrId={initialHrId}
      initialPeriod={initialPeriod}
      initialTo={formatPlainDateIso(to)}
    />
  );
}
