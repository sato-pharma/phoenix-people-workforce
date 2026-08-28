import Link from "next/link";
import type { ReactNode } from "react";
import {
  Activity,
  BriefcaseBusiness,
  ChartColumnBig,
  ChartNoAxesColumnIncreasing,
  ClipboardCheck,
  Hourglass,
  Inbox,
  Megaphone,
  MessageSquareText,
  Network,
  PlusCircle,
  RotateCcw,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

import {
  AdminLinkHint,
  AdminStatCard,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
import type { MarketingOverviewMetrics } from "@/lib/marketing-requests/service";

const egp = (value: number) =>
  new Intl.NumberFormat("en-EG", {
    currency: "EGP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(Number.isFinite(value) ? value : 0);

type Kpi = {
  description: string;
  href: string;
  icon: ReactNode;
  label: string;
  tone: "orange" | "blue" | "emerald" | "violet" | "rose";
  value: number;
};

type QuickAction = {
  href: string;
  icon: ReactNode;
  label: string;
  description: string;
};

export function MarketingOverviewDashboard({
  basePath,
  data,
}: {
  basePath: string;
  data: MarketingOverviewMetrics;
}) {
  const kpis: Kpi[] = [
    {
      description: "Requests at your Marketing Review step, waiting on your decision.",
      href: `${basePath}/inbox`,
      icon: <Inbox className="h-5 w-5" />,
      label: "Awaiting your approval",
      tone: "rose",
      value: data.awaitingMyDecision,
    },
    {
      description: "Advisory requests where you can add a non-blocking comment.",
      href: `${basePath}/inbox`,
      icon: <MessageSquareText className="h-5 w-5" />,
      label: "Awaiting your comment",
      tone: "blue",
      value: data.awaitingMyComment,
    },
    {
      description: "Marketing requests currently moving through the approval chain.",
      href: basePath,
      icon: <Megaphone className="h-5 w-5" />,
      label: "In approval",
      tone: "violet",
      value: data.inApprovalTotal,
    },
    {
      description: "Requests returned to their submitter for edits.",
      href: basePath,
      icon: <RotateCcw className="h-5 w-5" />,
      label: "Returned",
      tone: "orange",
      value: data.returnedTotal,
    },
    {
      description: "Customer and pharmacy links still awaiting validation.",
      href: `${basePath}/validation`,
      icon: <ShieldCheck className="h-5 w-5" />,
      label: "Validation pending",
      tone: "emerald",
      value: data.validationPending,
    },
  ];

  const quickActions: QuickAction[] = [
    {
      description: "Draft a new marketing activity.",
      href: basePath,
      icon: <PlusCircle className="h-4 w-4" />,
      label: "New request",
    },
    {
      description: "Decide requests at your step.",
      href: `${basePath}/inbox`,
      icon: <Inbox className="h-4 w-4" />,
      label: "Approval inbox",
    },
    {
      description: "Validate customers & pharmacies.",
      href: `${basePath}/validation`,
      icon: <ShieldCheck className="h-4 w-4" />,
      label: "Customer validation",
    },
    {
      description: "Review realized vs required ROI.",
      href: `${basePath}/roi-tracking`,
      icon: <ChartColumnBig className="h-4 w-4" />,
      label: "ROI tracking",
    },
    {
      description: "Company sales & customer intelligence.",
      href: "/admin/sales-marketing-intelligence",
      icon: <Sparkles className="h-4 w-4" />,
      label: "ROI & intelligence",
    },
  ];

  // Executive oversight surfaces — company-wide READ reports the Marketing Manager now sees
  // (mirrors PM/GPM/TM data). Pure links, so a slow/empty report never blocks this landing.
  const reportLinks: QuickAction[] = [
    {
      description: "Company monthly sales by brick & region.",
      href: "/sales/monthly-dashboard",
      icon: <Network className="h-4 w-4" />,
      label: "Source of Sales",
    },
    {
      description: "Company sales performance overview.",
      href: "/sales",
      icon: <ChartNoAxesColumnIncreasing className="h-4 w-4" />,
      label: "Sales Dashboard",
    },
    {
      description: "Weekly sales trend & breakdowns.",
      href: "/sales/weekly/dashboard",
      icon: <ChartColumnBig className="h-4 w-4" />,
      label: "Weekly Sales",
    },
    {
      description: "Company coaching reports (view).",
      href: "/coaching",
      icon: <ClipboardCheck className="h-4 w-4" />,
      label: "Field Coaching",
    },
    {
      description: "Coaching trends across the company.",
      href: "/coaching/analytics",
      icon: <ChartColumnBig className="h-4 w-4" />,
      label: "Coaching Analytics",
    },
    {
      description: "Double-visit coverage & quality.",
      href: "/admin/double-visit-analytics",
      icon: <Activity className="h-4 w-4" />,
      label: "Double-Visit Analytics",
    },
    {
      description: "Company reporting structure.",
      href: "/workspace/organogram",
      icon: <Network className="h-4 w-4" />,
      label: "Organogram",
    },
    {
      description: "Open seats across the company.",
      href: "/workspace/vacancies",
      icon: <BriefcaseBusiness className="h-4 w-4" />,
      label: "Vacancies",
    },
    {
      description: "Probation tracker (view).",
      href: "/workspace/probation",
      icon: <Hourglass className="h-4 w-4" />,
      label: "Probation",
    },
  ];

  return (
    <div className="space-y-6">
      {/* ---- KPI cards ------------------------------------------------------------------------ */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {kpis.map((kpi) => (
          <Link
            aria-label={`${kpi.label}: ${kpi.value}`}
            className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 focus-visible:ring-offset-2"
            href={kpi.href}
            key={kpi.label}
          >
            <AdminStatCard
              description={kpi.description}
              icon={kpi.icon}
              label={kpi.label}
              tone={kpi.tone}
              value={kpi.value}
            />
          </Link>
        ))}
      </div>

      {/* ---- Quick actions -------------------------------------------------------------------- */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {quickActions.map((action) => (
          <Link
            className="group flex items-start gap-3 rounded-2xl border border-slate-200/90 bg-white/95 p-4 shadow-[0_8px_20px_rgba(15,23,42,0.05)] transition-all duration-200 hover:-translate-y-0.5 hover:border-orange-300/80 hover:shadow-[0_16px_32px_rgba(15,23,42,0.10)] focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-400"
            href={action.href}
            key={action.label}
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-orange-50 to-orange-100 text-orange-600 ring-1 ring-orange-200">
              {action.icon}
            </span>
            <span className="min-w-0">
              <span className="block text-phx-md font-black tracking-tight text-slate-900">{action.label}</span>
              <span className="mt-0.5 block text-phx-xs font-medium leading-4 text-slate-500">{action.description}</span>
            </span>
          </Link>
        ))}
      </div>

      {/* ---- Executive reports & intelligence ------------------------------------------------- */}
      <div>
        <h2 className="mb-3 text-phx-sm font-black uppercase tracking-[0.16em] text-slate-500">
          Executive reports &amp; intelligence
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {reportLinks.map((action) => (
            <Link
              className="group flex items-start gap-3 rounded-2xl border border-slate-200/90 bg-white/95 p-4 shadow-[0_8px_20px_rgba(15,23,42,0.05)] transition-all duration-200 hover:-translate-y-0.5 hover:border-orange-300/80 hover:shadow-[0_16px_32px_rgba(15,23,42,0.10)] focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-400"
              href={action.href}
              key={action.label}
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-slate-900 to-slate-700 text-white ring-1 ring-slate-900/10">
                {action.icon}
              </span>
              <span className="min-w-0">
                <span className="block text-phx-md font-black tracking-tight text-slate-900">{action.label}</span>
                <span className="mt-0.5 block text-phx-xs font-medium leading-4 text-slate-500">{action.description}</span>
              </span>
            </Link>
          ))}
        </div>
      </div>

      {/* ---- Pending your approval (preview) -------------------------------------------------- */}
      <AdminTableShell
        action={
          <Link
            className="inline-flex items-center"
            href={`${basePath}/inbox`}
          >
            <AdminLinkHint>Open inbox</AdminLinkHint>
          </Link>
        }
        description="The five oldest requests waiting on your decision. Open the inbox to act on them."
        title="Pending your approval"
      >
        {data.topPendingForMe.length === 0 ? (
          <div className="px-6 py-10 text-center">
            <p className="text-phx-base font-black text-slate-800">You&apos;re all caught up</p>
            <p className="mt-1 text-phx-sm font-medium text-slate-500">
              No marketing requests are waiting on your decision right now.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-phx-md">
              <thead className="bg-phx-ink text-phx-2xs font-bold uppercase tracking-[0.12em] text-white">
                <tr>
                  <th className="px-4 py-3">Request</th>
                  <th className="px-4 py-3">Customer</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3 text-right">Amount</th>
                  <th className="px-4 py-3">Current step</th>
                </tr>
              </thead>
              <tbody>
                {data.topPendingForMe.map((row) => (
                  <tr className="border-b border-[#FEE7D2] last:border-0 hover:bg-orange-50/40" key={row.id}>
                    <td className="px-4 py-3 font-mono text-phx-xs font-bold text-slate-600">{row.requestCode}</td>
                    <td className="px-4 py-3 font-bold text-slate-900">{row.customerName}</td>
                    <td className="px-4 py-3 font-medium text-slate-600">{row.requestType}</td>
                    <td className="px-4 py-3 text-right font-bold text-slate-900">{egp(row.estimatedCost)}</td>
                    <td className="px-4 py-3 font-medium text-slate-600">{row.currentStepName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </AdminTableShell>
    </div>
  );
}
