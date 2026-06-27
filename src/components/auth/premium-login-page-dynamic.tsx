"use client";

import dynamic from "next/dynamic";

type PremiumLoginPageDynamicProps = {
  returnUrl?: string;
};

export const PremiumLoginPageDynamic = dynamic<PremiumLoginPageDynamicProps>(
  () => import("@/components/auth/premium-login-page").then((mod) => mod.PremiumLoginPage),
  { ssr: false },
);

