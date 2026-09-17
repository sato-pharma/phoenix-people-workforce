import { redirect } from "next/navigation";

// Plan reviews live on the Team tab of Phoenix CRM, the clean module that replaced the 2026-09-14 pilot
// (the owner, 2026-09-16). Old links and notices land there, and the tab decides who may see it.
export default function NativePlanReviewsPage() {
  redirect("/employee-portals/field-crm?tab=team");
}
