import { redirect } from "next/navigation";

import { CvLookupSearch } from "@/components/recruitment/cv-lookup-search";
import { canAccess, isHrAuthorityRole } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

/**
 * CV LOOKUP — search the CV database and reach only what the search returned.
 *
 * Built 2026-09-30 at the owner's instruction, for Yasmeena Elsafory (`HR-009`, HR Operations):
 * "i want to make something that she can search the cvs in admin account and finds only what it
 * search for i dont want her to have access to all cvs."
 *
 * ── THIS PAGE LOADS NO CANDIDATES, AND THAT IS THE POINT ────────────────────────────────────────
 *
 * Every other CV surface begins by fetching the pool — the CV Database next door loads it through
 * `listCandidates`, the screening workspace ships ~683 kB of it — and this one fetches nothing
 * at all. The client component holds a search box and asks the API only when it is used. Loading
 * the pool here and hiding it in the browser would have left the whole database sitting in the
 * HTML for anyone who opened the page source, which is the thing being withheld, not a view of it.
 *
 * ── THE GATE IS `cv_lookup:read`, NOT `candidates:read` ─────────────────────────────────────────
 *
 * `candidates:read` IS the pool, and HR Operations deliberately does not hold it — the CV Database
 * was shut to this same seat on 2026-09-01 for exactly that reason, and
 * tests/cv-database-recruiting-boundary.test.ts pins it shut. So this screen has a resource of its
 * own, capped at `read` for HR authority roles by the hard boundary in permissions.ts, and the two
 * API routes behind the screen assert the same thing — the gate is the revocation, not the sidebar.
 *
 * `isHrAuthorityRole` is asserted beside the grant, the same pair every other recruitment-adjacent
 * page states inline. It is belt and braces today (the hard boundary already refuses every other
 * role) and it is cheap: it keeps this page refusing on its own if the boundary is ever loosened.
 */
export default async function CvLookupPage() {
  const access = await resolveAccessContextFromPage();
  if (!isHrAuthorityRole(access.role) || !(await canAccess(access, "cv_lookup", "read"))) {
    redirect("/employee-portals");
  }

  return <CvLookupSearch />;
}
