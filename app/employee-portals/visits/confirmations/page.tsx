import { redirect } from "next/navigation";

// Visit confirmations moved into Phoenix CRM (the owner, 2026-09-14). Old links and notices land on its
// Visits tab, which decides who may see it.
export default function NativeVisitConfirmationsPage() {
  redirect("/employee-portals/phoenix-crm?tab=visits");
}
