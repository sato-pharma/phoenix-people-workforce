import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const access = await resolveAccessContextFromPage();

  if (access.loginId) {
    redirect(resolveLandingPathForRole(access.role));
  }

  redirect("/login");
}
