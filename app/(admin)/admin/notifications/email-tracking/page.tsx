import { redirect } from "next/navigation";
import { MousePointerClick } from "lucide-react";

import { AdminInsightChip, AdminPageHero } from "@/components/admin/admin-design-system";
import { EmailEngagementView } from "@/components/admin/email-engagement-view";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getEmailEngagement } from "@/lib/email/engagement";

export const dynamic = "force-dynamic";

export default async function AdminEmailTrackingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!(await canAccess(access, "communication", "read"))) {
    redirect("/admin");
  }

  const params = await searchParams;
  const asString = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";
  const search = asString(params.search);
  const statusRaw = asString(params.status);
  const status = statusRaw === "opened" || statusRaw === "clicked" ? statusRaw : "all";
  const daysRaw = Number(asString(params.days));
  const days = daysRaw === 7 || daysRaw === 90 ? daysRaw : 30;

  const data = await getEmailEngagement({ days, search, status });

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-6 text-slate-950 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-[1500px] space-y-6">
        <AdminPageHero
          badges={(
            <>
              <AdminInsightChip tone="emerald">{data.summary.opened} opens</AdminInsightChip>
              <AdminInsightChip tone="orange">{data.summary.clicked} clicks</AdminInsightChip>
              <AdminInsightChip tone="slate">{data.summary.recipients} people</AdminInsightChip>
            </>
          )}
          description="See who opened and clicked notification emails, across both providers (Resend and Brevo)."
          eyebrow="Admin / Notifications"
          icon={<MousePointerClick className="h-4 w-4" />}
          title="Email Engagement"
        />

        <EmailEngagementView data={data} filters={{ days, search, status }} />
      </div>
    </main>
  );
}
