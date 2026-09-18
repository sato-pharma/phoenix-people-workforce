import { redirect } from "next/navigation";

import {
  pageHeaderDescriptionClassName,
  pageHeaderKickerClassName,
  pageHeaderRailClassName,
  pageHeaderRuleClassName,
  pageHeaderTitleClassName,
} from "@/components/admin/admin-design-tokens";
import { VisualAidsWorkspace } from "@/components/visual-aids/visual-aids-workspace";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

/**
 * The admin-shell half of Visual Aids: upload, retire and replace. The same workspace the portal
 * page renders, so the two can never drift into two behaviours. A portal-mode viewer (a rep, the
 * Marketing Manager, the GPM) is sent to the portal page instead.
 */
export default async function AdminVisualAidsPage() {
  // Inline for the same reason the portal page is: a nav entry's `permission` mirrors the gate the
  // page itself enforces, and the guard that keeps them honest reads this file.
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals/visual-aids");
  }
  if (!(await canAccess(access, "visual_aids", "update"))) {
    redirect("/overview");
  }

  return (
    <div className="space-y-6 p-6 sm:p-8">
      <div className="relative pb-4">
        <span aria-hidden="true" className={`absolute inset-x-0 bottom-0 ${pageHeaderRuleClassName}`} />
        <div className="relative min-w-0 space-y-1.5 pl-3.5">
          <span aria-hidden="true" className={pageHeaderRailClassName} />
          <p className={pageHeaderKickerClassName}>Marketing</p>
          <h1 className={pageHeaderTitleClassName}>Visual Aids</h1>
          <p className={pageHeaderDescriptionClassName}>
            The flyers and visual aids reps show doctors on their tablets. Upload one against a line,
            retire it to hide it from the field, or replace it with a newer version.
          </p>
        </div>
      </div>

      <VisualAidsWorkspace />
    </div>
  );
}
