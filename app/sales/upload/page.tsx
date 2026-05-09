import { AppShell } from "@/components/layout/app-shell";
import { SalesUpload } from "@/components/sales/sales-upload";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { redirect } from "next/navigation";

export default async function SalesUploadPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals/sales");
  }
  await assertPermission(access, "sales", "import");

  return (
    <AppShell>
      <SalesUpload />
    </AppShell>
  );
}
