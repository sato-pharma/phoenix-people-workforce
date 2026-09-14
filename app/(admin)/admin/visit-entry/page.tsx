import { redirect } from "next/navigation";

// Visits for Reps moved into Phoenix CRM (the owner, 2026-09-14). Old links land on its Visits tab (the
// default tab), which decides who may see it.
export default async function AdminVisitEntryPage() {
  redirect("/admin/phoenix-crm");
}
