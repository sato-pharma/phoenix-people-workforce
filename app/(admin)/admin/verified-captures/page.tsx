import { redirect } from "next/navigation";

import {
  pageHeaderDescriptionClassName,
  pageHeaderKickerClassName,
  pageHeaderRailClassName,
  pageHeaderRuleClassName,
  pageHeaderTitleClassName,
} from "@/components/admin/admin-design-tokens";
import { VerifiedCapturesWorkspace } from "@/components/admin/verified-captures-workspace";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canOpenVerifiedCaptures } from "@/lib/verified-captures/access";

export const dynamic = "force-dynamic";

// Super Admin only (owner, 2026-09-24). The absence of a permission prompt is not approval — the
// service re-asserts this on every load; the redirect here just spares a denied viewer a broken page.
export default async function AdminVerifiedCapturesPage() {
  const access = await resolveAccessContextFromPage();
  if (!canOpenVerifiedCaptures(access)) redirect("/overview");

  return (
    <div className="space-y-6 p-6 sm:p-8">
      <div className="relative pb-4">
        <span aria-hidden="true" className={`absolute inset-x-0 bottom-0 ${pageHeaderRuleClassName}`} />
        <div className="relative min-w-0 space-y-1.5 pl-3.5">
          <span aria-hidden="true" className={pageHeaderRailClassName} />
          <p className={pageHeaderKickerClassName}>Field evidence</p>
          <h1 className={pageHeaderTitleClassName}>Verified Captures</h1>
          <p className={pageHeaderDescriptionClassName}>
            Every customer captured in the field with a live photo and location — direct orders and
            validated marketing requests — filterable by rep and district manager.
          </p>
        </div>
      </div>
      <VerifiedCapturesWorkspace />
    </div>
  );
}
