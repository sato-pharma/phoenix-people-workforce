import { redirect } from "next/navigation";

import {
  pageHeaderDescriptionClassName,
  pageHeaderKickerClassName,
  pageHeaderRailClassName,
  pageHeaderRuleClassName,
  pageHeaderTitleClassName,
} from "@/components/admin/admin-design-tokens";
import { BusinessCardRequestsQueue } from "@/components/business-cards/business-card-requests-queue";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { listAllBusinessCardRequests } from "@/lib/business-cards/request-service";

export const dynamic = "force-dynamic";

export default async function AdminBusinessCardRequestsPage() {
  const access = await resolveAccessContextFromPage();
  const canRead = await canAccess(access, "business_card_requests", "read");
  if (!canRead) {
    redirect("/overview");
  }
  const canManage = await canAccess(access, "business_card_requests", "update");

  let initialItems = [] as Awaited<ReturnType<typeof listAllBusinessCardRequests>>;
  try {
    initialItems = await listAllBusinessCardRequests(access, { status: "all", limit: 200 });
  } catch {
    initialItems = [];
  }

  return (
    <div className="space-y-6">
      <section className="min-w-0">
        <div className="relative space-y-1.5 pb-4 pl-3.5">
          <span aria-hidden="true" className={pageHeaderRailClassName} />
          <p className={pageHeaderKickerClassName}>Employee Documents</p>
          <h1 className={pageHeaderTitleClassName}>Business Card Requests</h1>
          <p className={pageHeaderDescriptionClassName}>
            Every business card an employee has asked for, with the name and number they want printed. Print
            from the Business Cards generator, then move each request through Pending, In Progress, Printed and
            Cancelled.
          </p>
        </div>
        <div aria-hidden="true" className={pageHeaderRuleClassName} />
      </section>
      <BusinessCardRequestsQueue canManage={canManage} initialItems={initialItems} />
    </div>
  );
}
