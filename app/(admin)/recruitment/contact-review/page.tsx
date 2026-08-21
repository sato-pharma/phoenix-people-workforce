import { redirect } from "next/navigation";

import { ContactReviewView } from "@/components/recruitment/contact-review-view";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canReviewCandidateContacts } from "@/lib/recruitment/access";
import { listContactReviewQueue } from "@/lib/recruitment/contact-review-service";

export const dynamic = "force-dynamic";

// Candidates nobody can contact, and the contact details their own CV already gave us.
//
// Measured on production 2026-08-21: 250 of 549 candidates had neither an email nor a phone, and
// 219 of those had one or both already extracted. cv-auto-apply.ts is right to refuse to write
// email unattended — it decides de-duplication — so this is the attended path for the same data.
export default async function ContactReviewPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals/contact-review");
  }
  if (!canReviewCandidateContacts(access)) {
    redirect("/employee-portals");
  }

  let rows;
  try {
    rows = await listContactReviewQueue();
  } catch (error) {
    const message = String((error as { message?: unknown })?.message ?? error);
    return (
      <div className="mx-auto max-w-3xl p-6">
        <h1 className="text-lg font-semibold text-slate-900">Contact review unavailable</h1>
        <p className="mt-2 text-sm text-slate-600">{message}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-6">
      <div className="mb-4">
        <h1 className="text-lg font-semibold text-slate-900">Missing Contact Details</h1>
        <p className="text-sm text-slate-500">
          Candidates with no email or phone on record whose own CV carries one. Accepting fills only the blank column
          — anything already on the record always wins.
        </p>
      </div>
      <ContactReviewView rows={rows} />
    </div>
  );
}
