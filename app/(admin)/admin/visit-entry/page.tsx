import { redirect } from "next/navigation";

// Visits for Reps lives in Phoenix CRM, the clean module that replaced the 2026-09-14 pilot (the owner,
// 2026-09-16). Old links land on its opening tab, which decides who may see it.
export default async function AdminVisitEntryPage() {
  redirect("/admin/field-crm");
}
