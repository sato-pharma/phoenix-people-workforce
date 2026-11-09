import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { PremiumLoginPage } from "@/components/auth/premium-login-page";
import { systemIdentity } from "@/config/system-settings";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { safeReturnUrl } from "@/lib/auth/safe-return-url";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const metadata: Metadata = {
  title: systemIdentity.appName,
};

export const dynamic = "force-dynamic";

type LoginPageProps = {
  searchParams?: Promise<{
    error?: string | string[];
    reason?: string | string[];
    returnUrl?: string | string[];
  }>;
};

function firstSearchParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

async function resolveSessionRedirectRole() {
  const access = await resolveAccessContextFromPage();
  return access.loginId ? access.role : null;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const reason = firstSearchParam(params?.reason);
  const error = firstSearchParam(params?.error);
  const returnUrl = safeReturnUrl(firstSearchParam(params?.returnUrl));
  const shouldRenderLogin = reason === "session-timeout" || Boolean(error);

  if (!shouldRenderLogin) {
    const role = await resolveSessionRedirectRole();
    if (role) {
      redirect(returnUrl ?? resolveLandingPathForRole(role));
    }
  }

  return <PremiumLoginPage returnUrl={returnUrl ?? undefined} />;
}
