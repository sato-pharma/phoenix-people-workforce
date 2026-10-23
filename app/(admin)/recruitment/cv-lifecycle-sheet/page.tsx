import { Link2 } from "lucide-react";
import { redirect } from "next/navigation";

import { PageContainer } from "@/components/layout/page-container";
import { CvLifecycleShareLinksView } from "@/components/recruitment/cv-lifecycle-share-links-view";
import { RecruitmentPageHeader } from "@/components/recruitment/recruitment-premium";
import { systemDeployment } from "@/config/system-settings";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { guardSeatPage } from "@/lib/auth/seat-page-guard";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

// CV Sheet Links — the management screen for the bearer tokens behind the owner's live
// CV-lifecycle Google Sheet.
//
// WHY IT EXISTS. #3102 (2026-09-04) shipped the whole feature — the domain service, the API, the
// table, the Apps Script — with NO user interface, so the first and only token had to be minted by
// hand in SQL against production, with the audit row hand-written to match what the route writes.
// Nothing in Phoenix could list, revoke or renew it. On 2027-09-04 it would have started answering
// 403 while the sheet went on showing yesterday's numbers rather than an error, which is the one
// failure mode nobody notices. This page closes both halves: the management surface, and the
// warning that the feed is about to go dark (which the daily recruitment run also pushes at a
// person — see cv-lifecycle-link-expiry-alert.ts).
//
// GATED ON `recruitment:export`, EXACTLY AS THE API IS. Not `recruitment:read`: reading the
// candidate pool inside Phoenix and minting a credential that copies it out to a spreadsheet are
// different acts, and only the second survives the person who performed it. Matching the API's own
// gate is deliberate — a page narrower than its API would strand a holder who can still call it,
// and a page wider would offer a link that bounces on arrival. `recruitment` is capped to HR
// authority in the permission matrix, so today the audience is Super Admin and HR Advisory; the
// CEO's recruitment grant is read-only and does not reach here.
//
// A PLAIN SIDEBAR ROW, NOT a card on the Recruitment & Hiring hub — a ninth card there trips four
// unrelated CI invariants for no more reach than a route and a link already give. The same choice
// Returned CVs and Manager CV Engagement made next door. The nav rows carry this same
// recruitment:export clause, so the gate and the link cannot drift
// (tests/every-offered-link-opens.test.ts).
export default async function CvLifecycleSheetLinksPage() {
  const access = await resolveAccessContextFromPage();
  guardSeatPage(access, "/recruitment/cv-lifecycle-sheet");
  if (resolveNavigationMode(access) === "employee-portal") redirect("/employee-portals");
  if (!(await canAccess(access, "recruitment", "export"))) redirect("/employee-portals");

  return (
    <PageContainer>
      <div className="space-y-6">
        <RecruitmentPageHeader
          description="The links that feed the live CV-lifecycle Google Sheet. Each one is a password-free key to every candidate's name and phone number, so it belongs in the sheet's Apps Script and nowhere else. Create one, watch when it expires, and revoke it the moment it is no longer needed."
          icon={<Link2 aria-hidden="true" className="h-3.5 w-3.5" />}
          title="CV Sheet Links"
        />
        <CvLifecycleShareLinksView productionUrl={systemDeployment.productionUrl} />
      </div>
    </PageContainer>
  );
}
