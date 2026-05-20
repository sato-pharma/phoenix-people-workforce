import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { PremiumLoginPage } from "@/components/auth/premium-login-page";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import {
  getCookieValue,
  phoenixSessionCookieName,
  verifySessionToken,
} from "@/lib/auth/session-token";

export const metadata: Metadata = {
  title: "Phoenix Workforce",
};

export const dynamic = "force-dynamic";

type LoginPageProps = {
  searchParams?: Promise<{
    error?: string | string[];
    reason?: string | string[];
  }>;
};

function firstSearchParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

async function resolveSessionRedirectRole() {
  const headerStore = await headers();
  const session = verifySessionToken(
    getCookieValue(headerStore.get("cookie"), phoenixSessionCookieName),
  );

  return session?.role ?? null;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const reason = firstSearchParam(params?.reason);
  const error = firstSearchParam(params?.error);
  const shouldRenderLogin = reason === "session-timeout" || Boolean(error);

  if (!shouldRenderLogin) {
    const role = await resolveSessionRedirectRole();
    if (role) {
      redirect(resolveLandingPathForRole(role));
    }
  }

  return <PremiumLoginPage />;
}
