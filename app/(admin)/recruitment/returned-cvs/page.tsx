import { redirect } from "next/navigation";

import { PageContainer } from "@/components/layout/page-container";
import { ReturnedCvsQueue } from "@/components/recruitment/returned-cvs-queue";
import { canAccess, isHrAuthorityRole } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { listReturnedCvQueue } from "@/lib/recruitment/district-returns";

export const dynamic = "force-dynamic";

// Returned CVs — the administrator's side of the district-manager "return this CV" action.
//
// The owner, 2026-09-01: *"when they do this, the CV comes back in a folder based on the district
// manager who is sending it ... return this CV to the administrator because area not match — or any
// other situation."* So this page is one pile per returning manager, split by the reason he gave,
// and it is where the recruiting admin decides what to do with each — re-route it, or mark it
// handled. Marking it handled clears the row but leaves the CV suppressed from that manager's folder
// (see district-returns.ts): the manager's decision stands; this is the admin acknowledging it.
//
// Gated exactly as the Recruitment & Hiring hub is — isHrAuthorityRole AND recruitment:read — so the
// audience is the recruiting admins who work the pipeline (Super Admin, HR Advisory), never the
// district managers who fill the queue and never the CEO, whose recruitment grants are stripped at
// runtime. The nav row that offers this link carries the same recruitment:read clause, so the two
// cannot drift (tests/every-offered-link-opens.test.ts).
//
// A plain sidebar row, NOT a card on the Recruitment & Hiring hub — a ninth card there trips four
// unrelated CI invariants for no more reach than a route and a link already give. Same choice the
// Manager CV Engagement report made next door.
export default async function ReturnedCvsPage() {
  const access = await resolveAccessContextFromPage();
  if (!isHrAuthorityRole(access.role) || !(await canAccess(access, "recruitment", "read"))) {
    redirect("/employee-portals");
  }

  const groups = await listReturnedCvQueue();

  return (
    <PageContainer>
      <div className="mb-4">
        <h1 className="text-lg font-semibold text-slate-900">Returned CVs</h1>
        <p className="text-sm text-slate-500">
          CVs a district manager handed back — grouped by the manager who returned them and the reason he gave. Re-route
          each one, then mark it handled to clear it from the queue.
        </p>
      </div>
      <ReturnedCvsQueue groups={groups} />
    </PageContainer>
  );
}
