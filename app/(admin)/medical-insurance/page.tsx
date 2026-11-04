import { redirect } from "next/navigation";
import { Suspense } from "react";

import { MedicalInsurancePage } from "@/components/medical-insurance/medical-insurance-page";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { canAccess, resolveNavigationMode, type AccessContext } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getMedicalInsuranceMoney, getMedicalInsuranceView, isMedicalInsuranceSchemaMissing, medicalInsuranceErrorMessage } from "@/lib/medical-insurance/service";
import type { MedicalInsuranceMoneyView, MedicalInsuranceView } from "@/lib/medical-insurance/view";

export const dynamic = "force-dynamic";

export default async function MedicalInsuranceRoutePage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals");
  }

  if (!(await canAccess(access, "medical_insurance", "read"))) {
    redirect("/employee-portals");
  }

  return (
    <Suspense fallback={<AppRouteLoadingState description="Checking who should be on the policy against who is." title="Loading Medical Insurance" />}>
      <MedicalInsuranceContent access={access} />
    </Suspense>
  );
}

async function MedicalInsuranceContent({ access }: { access: AccessContext }) {
  const [canEdit, canCreate, canExport, holdsInvoices] = await Promise.all([
    canAccess(access, "medical_insurance", "update"),
    canAccess(access, "medical_insurance", "create"),
    canAccess(access, "medical_insurance", "export"),
    canAccess(access, "medical_insurance_invoices", "read"),
  ]);

  let view: MedicalInsuranceView | null = null;
  let money: MedicalInsuranceMoneyView | null = null;
  let error: string | null = null;

  try {
    view = await getMedicalInsuranceView();
    // 🔴 Read only after the check, so an amount never reaches a seat's page data. See view.ts.
    if (view && holdsInvoices) money = await getMedicalInsuranceMoney();
  } catch (caught) {
    error = isMedicalInsuranceSchemaMissing(caught)
      ? "Medical insurance is not ready yet: its database tables have not been applied."
      : medicalInsuranceErrorMessage(caught);
  }

  return <MedicalInsurancePage canCreate={canCreate} canEdit={canEdit} canExport={canExport} error={error} money={money} view={view} />;
}
