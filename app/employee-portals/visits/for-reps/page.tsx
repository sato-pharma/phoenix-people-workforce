import { redirect } from "next/navigation";

// Entering visits lives in Phoenix CRM, the clean module that replaced the 2026-09-14 pilot (the owner,
// 2026-09-16). Old links land on its Visits tab, which decides who may see it.
export default function VisitsForRepsPage() {
  redirect("/employee-portals/field-crm?tab=visits");
}
