import { Lock, UserRoundX } from "lucide-react";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import type { ReactNode } from "react";

import { adminPanelDepthClassName } from "@/components/admin/admin-design-tokens";
import { PageContainer } from "@/components/layout/page-container";
import { CandidateRecordPage } from "@/components/recruitment/candidate-record-page";
import { RecruitmentEmptyState } from "@/components/recruitment/recruitment-premium";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { canAccess, isHrAuthorityRole, type AccessContext } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { parseCandidatePageId } from "@/lib/recruitment/candidate-page-link";
import { loadCandidateRecord } from "@/lib/recruitment/candidate-record";
import { candidateHiddenFrom } from "@/lib/recruitment/workspace/fence";

export const dynamic = "force-dynamic";

/**
 * One candidate's own page — everything the system holds on them.
 *
 * The owner, 2026-09-18: "when I press on the name of the person, I am jumped to a new page which
 * shows the full details on everything for this candidate." The name in the candidate pool and on
 * WhatsApp Applicants opens this page in a new tab.
 *
 * READ-ONLY. It never marks the CV read and never holds it for the viewer — see candidate-record.ts.
 * Decisions are made on the screening page, which this page links to.
 *
 * Same permission gate as /recruitment/screening, and for the same reason: this page reads every
 * field on the candidate, so anything looser would be a way around the module's own gate.
 */
export default async function RecruitmentCandidatePage({ params }: { params: Promise<{ id: string }> }) {
  const access = await resolveAccessContextFromPage();
  if (!isHrAuthorityRole(access.role) || !(await canAccess(access, "recruitment", "read"))) {
    redirect("/employee-portals");
  }

  const { id } = await params;

  return (
    <PageContainer>
      <Suspense
        fallback={
          <AppRouteLoadingState description="Loading everything on file for this candidate." title="Opening the candidate" />
        }
      >
        <CandidateContent access={access} rawId={id} />
      </Suspense>
    </PageContainer>
  );
}

async function CandidateContent({ access, rawId }: { access: AccessContext; rawId: string }) {
  // A module lock on `candidates` alone leaves `recruitment: read` true — the screening page's own
  // account of why this branch is reachable. Such a caller gets a sentence, not the record.
  if (!(await canAccess(access, "candidates", "read"))) {
    return (
      <CandidateFallback
        icon={<Lock aria-hidden="true" className="h-5 w-5" />}
        message={<>A candidate&apos;s page is available to roles that can read the candidate pool.</>}
        title="Not available to your role"
      />
    );
  }

  // An edited or cut-off link is checked before the database is asked: a malformed id makes the
  // query fail outright rather than answer "no such candidate".
  const candidateId = parseCandidatePageId(rawId);
  // The offer letter is read ONLY for a viewer who may see offer letters. `candidates: read` is a
  // wider set of seats than `offers: read`, and a letter is where the salary lives — so this is a
  // separate question from "may they open the record", and it is asked separately.
  // The Talent Acquisition fence (owner, 2026-10-20): an HR applicant is "no such candidate" to her,
  // the same page a deleted record gets — asked before the record is read at all.
  const hidden = candidateId ? await candidateHiddenFrom(access, candidateId) : true;
  const record =
    candidateId && !hidden
      ? await loadCandidateRecord(candidateId, { withOffer: await canAccess(access, "offers", "read") })
      : null;
  if (!record) {
    return (
      <CandidateFallback
        icon={<UserRoundX aria-hidden="true" className="h-5 w-5" />}
        message="This candidate is not in the system. The link may be incomplete, or the record may have been removed. Go back to the candidate pool and open the name from there."
        title="No such candidate"
      />
    );
  }

  return <CandidateRecordPage record={record} />;
}

/** The sentence a reader gets instead of the record, in the module's lifted empty-state panel. */
function CandidateFallback({ icon, message, title }: { icon: ReactNode; message: ReactNode; title: string }) {
  return (
    <div className={`border border-slate-200 bg-white ${adminPanelDepthClassName}`}>
      <RecruitmentEmptyState icon={icon} message={message} title={title} />
    </div>
  );
}
