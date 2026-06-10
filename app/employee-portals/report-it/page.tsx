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
        <ReportItForm />
      </div>
    </main>
  );
}
