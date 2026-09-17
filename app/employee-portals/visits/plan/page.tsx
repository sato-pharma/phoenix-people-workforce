import { redirect } from "next/navigation";

// Weekly planning lives in Phoenix CRM, the clean module that replaced the 2026-09-14 pilot (the owner,
// 2026-09-16). Old links and notices land on its Plan tab, which decides who may see it.
export default function NativeWeeklyPlanPage() {
  redirect("/employee-portals/field-crm?tab=plan");
}
