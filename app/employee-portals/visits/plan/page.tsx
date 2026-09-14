import { redirect } from "next/navigation";

// Weekly planning moved into Phoenix CRM (the owner, 2026-09-14). Old links and notices land on its
// Planning tab, which decides who may see it.
export default function NativeWeeklyPlanPage() {
  redirect("/employee-portals/phoenix-crm?tab=planning");
}
