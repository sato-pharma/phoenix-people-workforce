import { redirect } from "next/navigation";

import { ChequeWorkspace } from "@/components/spotlight/cheque-workspace";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { guardSeatPage } from "@/lib/auth/seat-page-guard";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { loadChequePayees } from "@/lib/spotlight/cheque-people";

export const dynamic = "force-dynamic";

/**
 * Award cheques - a presentation cheque for any bonus, to anyone, for anything.
 *
 * SUPER ADMIN AND CEO ONLY (`spotlight:export`, the permission that lets a person print a named
 * award, and the seat fence for the Talent Acquisition seat, which holds that permission for her
 * Spotlight sheet). The redirects below are UX; `/api/spotlight/cheques*` asserts the same two on
 * every call, and that is the boundary.
 */
export default async function AwardChequesPage() {
  const access = await resolveAccessContextFromPage();
  guardSeatPage(access, "/spotlight/cheques");
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect(resolveLandingPathForRole(access.role));
  }
  try {
    await assertPermission(access, "spotlight", "export");
  } catch {
    redirect(resolveLandingPathForRole(access.role));
  }

  // The picker is a convenience: if the roster cannot load, the form still works by typing.
  const payees = await loadChequePayees().catch(() => []);
  return <ChequeWorkspace payees={payees} />;
}
