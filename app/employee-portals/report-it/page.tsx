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
    <main className="p-4 sm:p-6">
      <div className="mx-auto max-w-6xl">
        <header className="mb-6">
          <p className="text-[11px] font-black uppercase tracking-[0.2em] text-orange-600">Pharmacovigilance</p>
          <h1 className="text-xl font-black text-slate-900">Report It</h1>
          <p className="mt-1 text-sm text-slate-600">
            Report an adverse drug reaction (ADR) in a safe, confidential way. Fields marked
            with <span className="font-bold text-rose-600">*</span> are required.
          </p>
        </header>
        <ReportItForm />
      </div>
    </main>
  );
}
