import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * The Marketing Coverage Report merged into the ROI Tracker module on 2026-09-22 (owner
 * instruction): it is now the Coverage tab of /employee-portals/roi-tracker. This route is kept as
 * a redirect so existing bookmarks and the command-palette catalog entry still land on the coverage
 * tab. The role gate now lives on the merged page, whose guard admits the Coverage viewer set
 * (including Finance Manager / Financial Advisor); redirecting unconditionally is safe because that
 * page re-checks access and shows only the tabs the viewer may see.
 */
export default function EmployeePortalMarketingCoverageReportPage() {
  redirect("/employee-portals/roi-tracker?tab=coverage");
}
