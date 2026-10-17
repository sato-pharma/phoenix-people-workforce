import { redirect } from "next/navigation";
import { Activity } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { SentryCheckPanel } from "@/components/admin/sentry-check-panel";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { parseSentryDsn, sentryServerStatus } from "@/lib/observability/sentry-policy";

export const dynamic = "force-dynamic";

// The Sentry example page. It exists to prove, on production, that an error thrown in the browser and an error thrown
// on the server both land in Sentry. It uses the SAME gate as the SDK itself (sentry-policy.ts): APP_ENV must be
// literally `production` and a DSN must be present, so on staging, a preview or a laptop the page only explains why
// it is off and offers no button.
export default async function SentryCheckPage() {
  const access = await resolveAccessContextFromPage();
  if (access.role !== "Super Admin") {
    redirect("/admin/admin-tools");
  }

  const server = sentryServerStatus({ appEnv: process.env.APP_ENV, dsn: process.env.SENTRY_DSN });
  const browserDsnPresent = parseSentryDsn(process.env.NEXT_PUBLIC_SENTRY_DSN) !== null;

  return (
    <div className="space-y-6">
      <AdminPageHero
        description="Send one deliberate test error from the browser and one from the server, then look for them in Sentry. Production only: on any other deployment this page shows why it is off and sends nothing."
        eyebrow="System · Production only"
        icon={<Activity className="h-3.5 w-3.5" />}
        title="Sentry Check"
      />
      <SentryCheckPanel
        browserDsnPresent={browserDsnPresent}
        serverReason={server.enabled ? null : server.reason}
      />
    </div>
  );
}
