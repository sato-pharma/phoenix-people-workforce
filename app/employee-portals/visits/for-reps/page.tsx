import { redirect } from "next/navigation";

// Entering visits for reps moved into Phoenix CRM (the owner, 2026-09-14). Old links land on its Visits
// tab, which decides who may see it.
export default function VisitsForRepsPage() {
  redirect("/employee-portals/phoenix-crm?tab=visits");
}
