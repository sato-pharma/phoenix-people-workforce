import { redirect } from "next/navigation";

import { ReportItForm } from "@/components/report-it/report-it-form";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function ReportItPage() {
  const access = await resolveAccessContextFromPage();

  if (!access.hrId) {
    redirect("/login");
  }

  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-bold">Report It</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Report an adverse drug reaction (ADR) in a safe, confidential way. All fields
          with <span className="text-red-500">*</span> are required.
        </p>
      </div>
      <ReportItForm />
    </div>
  );
}
