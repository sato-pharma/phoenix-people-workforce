import { redirect } from "next/navigation";

import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

/**
 * Page guards for the two Market Awareness shells.
 *
 * These are UX, not the security boundary. Every API route calls
 * `assertPermission(access, "market_awareness", ...)` and then narrows by identity, because the
 * permission matrix has no per-row layer and a Product Manager may see only his own activities.
 * A guard that redirects is a nicer 403; it is never the thing that stops anyone.
 */

export async function assertMarketAwarenessPortalAccess() {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/overview");
  }
  if (!(await canAccess(access, "market_awareness", "read"))) {
    redirect("/employee-portals");
  }

  return access;
}

export async function assertMarketAwarenessAdminAccess() {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals/market-awareness");
  }
  if (!(await canAccess(access, "market_awareness", "read"))) {
    redirect("/overview");
  }

  return access;
}
