import { AlertTriangle, Contact } from "lucide-react";
import { redirect } from "next/navigation";

import { AdminInsightChip } from "@/components/admin/admin-design-system";
import { adminChipDepthClassName, adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import { ContactReviewView } from "@/components/recruitment/contact-review-view";
import { RecruitmentPageHeader } from "@/components/recruitment/recruitment-premium";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { guardSeatPage } from "@/lib/auth/seat-page-guard";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canReviewCandidateContacts } from "@/lib/recruitment/access";
import { listContactReviewQueue } from "@/lib/recruitment/contact-review-service";
import { fenceRowsByCandidate } from "@/lib/recruitment/workspace/fence";

export const dynamic = "force-dynamic";

// Candidates nobody can contact, and the contact details their own CV already gave us.
//
// Measured on production 2026-08-21: 250 of 549 candidates had neither an email nor a phone, and
// 219 of those had one or both already extracted. cv-auto-apply.ts is right to refuse to write
// email unattended — it decides de-duplication — so this is the attended path for the same data.
export default async function ContactReviewPage() {
  const access = await resolveAccessContextFromPage();
  guardSeatPage(access, "/recruitment/contact-review");
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals/contact-review");
  }
  if (!canReviewCandidateContacts(access)) {
    redirect("/employee-portals");
  }

  let rows;
  try {
    // The Talent Acquisition fence (owner, 2026-10-20): an HR applicant is not on the queue she reads.
    rows = await fenceRowsByCandidate(access, await listContactReviewQueue(), (row) => row.candidateId);
  } catch (error) {
    const message = String((error as { message?: unknown })?.message ?? error);
    return (
      <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
        <ContactReviewHeader />
        <div
          className={`flex items-start gap-3 border border-amber-200 bg-amber-50 px-4 py-4 ${adminSoftDepthClassName}`}
          role="alert"
        >
          <span
            className={`flex h-9 w-9 flex-none items-center justify-center border border-amber-300 bg-white text-amber-600 ${adminChipDepthClassName}`}
          >
            <AlertTriangle aria-hidden="true" className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-black text-amber-950">Contact review unavailable</p>
            <p className="mt-1 break-words text-[13px] leading-5 text-amber-900">{message}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
      <ContactReviewHeader waiting={rows.length} />
      <ContactReviewView rows={rows} />
    </div>
  );
}

/** The page's one header, on the queue and on its error state alike. */
function ContactReviewHeader({ waiting }: { waiting?: number }) {
  return (
    <RecruitmentPageHeader
      badges={
        waiting === undefined ? undefined : (
          <>
            <AdminInsightChip tone={waiting > 0 ? "orange" : "emerald"}>
              {waiting === 0 ? "Nothing waiting" : waiting === 1 ? "1 candidate waiting" : `${waiting} candidates waiting`}
            </AdminInsightChip>
            <AdminInsightChip tone="slate">Blank columns only</AdminInsightChip>
          </>
        )
      }
      description="Candidates with no email or phone on record whose own CV carries one. Accepting fills only the blank column — anything already on the record always wins."
      icon={<Contact aria-hidden="true" className="h-3.5 w-3.5" />}
      title="Missing Contact Details"
    />
  );
}
