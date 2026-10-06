import type { Metadata } from "next";

import { PasswordResetRequestPage } from "@/components/auth/password-reset-request-page";
import { systemIdentity } from "@/config/system-settings";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: `Set or reset your password · ${systemIdentity.appName}`,
};

export default function PasswordResetPage() {
  return <PasswordResetRequestPage />;
}
