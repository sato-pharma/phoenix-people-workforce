import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { PremiumLoginPage } from "@/components/auth/premium-login-page";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const metadata: Metadata = {
  title: "Phoenix Workforce",
};

export default async function LoginPage() {
  const session = await resolveAccessContextFromPage();

  if (session.loginId && session.source !== "dev-header") {
    redirect(resolveLandingPathForRole(session.role));
  }

  return <PremiumLoginPage />;
}
