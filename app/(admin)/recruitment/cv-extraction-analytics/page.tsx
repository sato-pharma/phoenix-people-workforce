import { redirect } from "next/navigation";

import { CvExtractionAnalyticsView } from "@/components/recruitment/cv-extraction-analytics-view";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { canViewCvExtractionAnalytics } from "@/lib/recruitment/access";
import { getCvExtractionAccuracyAnalytics } from "@/lib/recruitment/cv-extraction-analytics";

export const dynamic = "force-dynamic";

// Read-only AI CV-extraction accuracy dashboard: per position, per field, how often Talent
// Acquisition corrected the AI's proposal before saving. Visibility only — does not feed back
// into extraction behavior.
export default async function CvExtractionAnalyticsPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals");
  }
  if (!canViewCvExtractionAnalytics(access)) {
    redirect("/employee-portals");
  }

  let data;
  try {
    data = await getCvExtractionAccuracyAnalytics();
  } catch (error) {
    const message = String((error as { message?: unknown })?.message ?? error);
    return (
      <div className="mx-auto max-w-3xl p-6">
        <h1 className="text-lg font-semibold text-slate-900">CV extraction analytics unavailable</h1>
        <p className="mt-2 text-sm text-slate-600">{message}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-6">
      <div className="mb-4">
        <h1 className="text-lg font-semibold text-slate-900">CV Extraction Accuracy</h1>
        <p className="text-sm text-slate-500">
          Reviewed extractions only. Shows how often Talent Acquisition corrected each proposed field before
          saving, by position — a high correction rate flags a field worth revisiting.
        </p>
      </div>
      <CvExtractionAnalyticsView data={data} />
    </div>
  );
}
