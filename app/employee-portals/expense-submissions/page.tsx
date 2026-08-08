import { redirect } from "next/navigation";

import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { MyExpenseSubmissions } from "@/components/outstation/my-expense-submissions";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { listOwnOutstationSubmissions } from "@/lib/outstation/service";

export const dynamic = "force-dynamic";

/**
 * The submitter's own view of his outstation submissions (owner request 2026-08-08).
 *
 * Deliberately separate from the Expense Dashboard, which is an ANALYTICS surface — charts, KPIs,
 * a ledger of everything visible to him including his team's. This page is the opposite: his own
 * submissions only, one row each, opening into the full story of a single trip.
 *
 * It is also where the departure photo now lives. Previously the only way to capture it was a card
 * on the dashboard that appeared solely while one was due and vanished the moment it was taken, so
 * an employee who wanted to check on his own evidence had nowhere to look.
 */
export default async function EmployeePortalExpenseSubmissionsPage() {
  const access = await resolveAccessContextFromPage();

  // A session that expired between the layout's auth check and this page's navigation resolves to
  // the guest fallback, which would otherwise surface as a misleading "Employee cannot read
  // expenses" instead of sending the user back to sign in.
  if (!access.loginId && !access.hrId) {
    redirect("/login");
  }

  const isProductMarketingRole =
    access.role === "Product Manager" ||
    access.role === "Group Product Manager" ||
    access.role === "Marketing Manager";
  if (resolveNavigationMode(access) !== "employee-portal" && !isProductMarketingRole) {
    redirect("/payroll");
  }

  await assertPermission(access, "expenses", "read");

  let submissions: Awaited<ReturnType<typeof listOwnOutstationSubmissions>> = [];
  let loadError: string | null = null;
  try {
    submissions = await listOwnOutstationSubmissions(access);
  } catch (error) {
    // Say the data is unavailable rather than rendering an empty list: "you have no submissions"
    // and "we could not read your submissions" must never look the same on a money screen.
    loadError = error instanceof Error ? error.message : "Unable to load your expense submissions.";
  }

  if (loadError) {
    return (
      <EmployeePortalEmptyState message={loadError} title="Expense Submissions unavailable" />
    );
  }

  return (
    <EmployeePortalPageShell
      badge="Expenses"
      description="Every outstation trip you have submitted, what it is waiting for, and what HR decided."
      errorBoundaryTitle="Expense Submissions unavailable"
      title="Expense Submissions"
    >
      <MyExpenseSubmissions employeeHrId={access.hrId ?? ""} submissions={submissions} />
    </EmployeePortalPageShell>
  );
}
