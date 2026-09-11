import { redirect } from "next/navigation";
import { MousePointerClick } from "lucide-react";

import { AdminInsightChip, AdminPageHero } from "@/components/admin/admin-design-system";
import { EmailEngagementView } from "@/components/admin/email-engagement-view";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getEmailActivity } from "@/lib/email/engagement";

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
  // 🔴 SUPER ADMIN ONLY, ON TOP OF THE RESOURCE GATE. Owner 2026-09-11.
  //
  // This is a COMPANY-WIDE email log. Every row carries the subject and the recipient of a mail the
  // system sent, so payroll, resignation, offer and probation mail are all named here — not their
  // bodies, but who received what and what it was called, which for those four is most of the
  // sensitivity.
  //
  // Until 2026-09-11 Super Admin was the only holder of `communication`, so this page was
  // Super-Admin-only by ACCIDENT rather than by rule. Granting `hr_communication` to the HR
  // Advisory seat, so she could run the distribution lists and the composer, made that accident
  // load-bearing. The owner was shown what the page exposes and chose to close it.
  //
  // The check is DELIBERATELY not folded into the resource gate above. `communication` is the right
  // resource for the composer and the templates she was actually given, and narrowing it would take
  // those away too; this page is the exception, so it carries the exception.
  //
  // There is no second door to close: `getEmailActivity` has exactly one caller, this page, and the
  // view it renders into takes server props with no fetch of its own. If an API route is ever added
  // over that data, it needs this same check — the gate cannot live in the component.
  if (access.role !== "Super Admin") {
    redirect("/admin");
  }

  const params = await searchParams;
  const asString = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";
  const search = asString(params.search);
  const providerRaw = asString(params.provider);
  const provider = providerRaw === "resend" || providerRaw === "brevo" ? providerRaw : "all";
  const activityRaw = asString(params.activity);
  const activity = activityRaw === "opened" || activityRaw === "clicked" || activityRaw === "not_sent" || activityRaw === "bounced" ? activityRaw : "all";
  const daysRaw = Number(asString(params.days));
  const days = daysRaw === 1 || daysRaw === 30 ? daysRaw : 7;

  const data = await getEmailActivity({ activity, days, provider, search });

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-6 text-slate-950 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-[1500px] space-y-6">
        <AdminPageHero
          badges={(
            <>
              <AdminInsightChip tone="emerald">{data.summary.sent} sent</AdminInsightChip>
              <AdminInsightChip tone="slate">{data.summary.opened} opened</AdminInsightChip>
              <AdminInsightChip tone="orange">{data.summary.clicked} clicked</AdminInsightChip>
              <AdminInsightChip tone="orange">{data.summary.notSent} not sent</AdminInsightChip>
            </>
          )}
          description="Each email's exact situation — sent, delivered, opened, clicked (or failed/bounced) — across both providers (Resend + Brevo)."
          eyebrow="Admin / Notifications"
          icon={<MousePointerClick className="h-4 w-4" />}
          title="Email Activity"
        />

        <EmailEngagementView data={data} filters={{ activity, days, provider, search }} />
      </div>
    </main>
  );
}
