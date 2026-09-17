import { redirect } from "next/navigation";

// Visit confirmations belonged to the 2026-09-14 pilot. Phoenix CRM, the clean module that replaced it
// (the owner, 2026-09-16), has no confirmation step: a double or chain visit counts for the manager at
// once. Old links and notices land on its Visits tab, which decides who may see it.
export default function NativeVisitConfirmationsPage() {
  redirect("/employee-portals/field-crm?tab=visits");
}
