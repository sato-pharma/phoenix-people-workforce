"use client";

import {
  ArrowRight,
  Boxes,
  CheckCircle2,
  Map as MapIcon,
  MapPin,
  Package,
  RefreshCw,
  Truck,
  TriangleAlert,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { LucideIcon } from "lucide-react";

import { AdminCallout, AdminInsightChip, AdminPageHero, AdminTableShell } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { formatNumber } from "@/lib/sales/format";
import type { ReferenceGapKind, SalesReferenceGaps } from "@/lib/sales/reference-gaps";
import { cn } from "@/lib/utils";

type WeeklyMissingProduct = { distributorCode: string; distributorName: string; itemCode: string; itemName: string; rowCount: number; batchCount: number; totalStock: number; earliestWeek: string | null; latestWeek: string | null };

const KIND_ICON: Record<ReferenceGapKind, LucideIcon> = {
  product: Package,
  brick: Boxes,
  area: MapPin,
  region: MapIcon,
  distributor: Truck,
};

const tableHeaderClassName = "px-4 py-3 text-xs font-black uppercase tracking-[0.14em] text-[#64748B]";
const cellClassName = "px-4 py-2.5 align-top text-[#475569]";

function joinCapped(values: string[], cap = 6): string {
  if (values.length === 0) return "—";
  if (values.length <= cap) return values.join(", ");
  return `${values.slice(0, cap).join(", ")} +${values.length - cap} more`;
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button className={cn("rounded-[6px] px-3.5 py-1.5 text-sm font-black transition", active ? "bg-[#0B0B0B] text-white" : "text-[#0F172A] hover:bg-[#FFF7ED]")} onClick={onClick} type="button">{children}</button>
  );
}

function MonthlyMissing({ data, loadError }: { data: SalesReferenceGaps | null; loadError: string | null }) {
  const totalGapCodes = data ? data.groups.reduce((sum, group) => sum + group.gaps.length, 0) : 0;
  const totalRows = data ? data.groups.reduce((sum, group) => sum + group.totalRows, 0) : 0;

  if (loadError) {
    return <AdminCallout tone="danger"><div><p className="font-semibold">Could not scan for missing data.</p><p>{loadError}</p></div></AdminCallout>;
  }
  if (!data || !data.hasGaps) {
    return <AdminCallout tone="success"><div><p className="font-semibold">No missing monthly data.</p><p>Every reference code in your validated monthly sheets matches a master.</p></div></AdminCallout>;
  }
  return (
    <div className="space-y-6">
      <AdminCallout tone="warning">
        <div>
          <p className="font-semibold">{totalGapCodes} reference code(s) across {formatNumber(totalRows)} row(s) need a master entry.</p>
          <p>Open the matching master in Master Data &amp; Profiles, add the missing row(s), then Rescan — the dashboards live-join the masters, so the affected sales rows distribute automatically.</p>
        </div>
      </AdminCallout>
      {data.groups.map((group) => {
        const Icon = KIND_ICON[group.kind];
        return (
          <AdminTableShell
            action={<Link href={group.fixHref}><Button className="rounded" type="button" variant="secondary">{group.fixLabel}<ArrowRight className="ml-2 h-4 w-4" /></Button></Link>}
            description={`${group.description} (${group.gaps.length} code(s), ${formatNumber(group.totalRows)} row(s))`}
            key={group.kind}
            title={group.label}
          >
            <div className="overflow-x-auto">
              <table className="w-full min-w-[680px] text-left text-sm">
                <thead><tr>
                  <th className={tableHeaderClassName}><span className="inline-flex items-center gap-2"><Icon className="h-4 w-4" />Code</span></th>
                  <th className={`${tableHeaderClassName} text-right`}>Rows affected</th>
                  <th className={tableHeaderClassName}>Distributors</th>
                  <th className={tableHeaderClassName}>Periods</th>
                </tr></thead>
                <tbody className="divide-y divide-[#E2E8F0]">
                  {group.gaps.map((gap) => (
                    <tr key={gap.code}>
                      <td className="px-4 py-2.5 font-semibold text-[#0F172A]">{gap.code}</td>
                      <td className={`${cellClassName} text-right tabular-nums`}>{formatNumber(gap.affectedRows)}</td>
                      <td className={cellClassName}>{joinCapped(gap.distributors)}</td>
                      <td className={cellClassName}>{joinCapped(gap.periods)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </AdminTableShell>
        );
      })}
      <p className="flex items-center gap-2 px-1 text-xs text-slate-500"><CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />Codes clear from this list as soon as their master row exists — Rescan to confirm.</p>
    </div>
  );
}

function WeeklyMissing({ rows, loadError }: { rows: WeeklyMissingProduct[]; loadError: string | null }) {
  if (loadError) {
    return <AdminCallout tone="danger"><div><p className="font-semibold">Could not load weekly missing products.</p><p>{loadError}</p></div></AdminCallout>;
  }
  if (rows.length === 0) {
    return <AdminCallout tone="success"><div><p className="font-semibold">No missing weekly products.</p><p>Every weekly item code resolves to a master product. Unmapped weekly items will surface here.</p></div></AdminCallout>;
  }
  return (
    <AdminTableShell
      action={<Link href="/sales/mapping-database"><Button className="rounded" type="button" variant="secondary">Fix in Mapping Database<ArrowRight className="ml-2 h-4 w-4" /></Button></Link>}
      description={`${rows.length} weekly item code(s) not yet mapped to a Phoenix product.`}
      title="Weekly — unmapped products"
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[680px] text-left text-sm">
          <thead><tr>
            <th className={tableHeaderClassName}>Item</th>
            <th className={tableHeaderClassName}>Distributor</th>
            <th className={`${tableHeaderClassName} text-right`}>Rows</th>
            <th className={tableHeaderClassName}>Weeks</th>
          </tr></thead>
          <tbody className="divide-y divide-[#E2E8F0]">
            {rows.map((r) => (
              <tr key={`${r.distributorCode}-${r.itemCode}`}>
                <td className="px-4 py-2.5"><span className="block font-semibold text-[#0F172A]">{r.itemName || r.itemCode}</span><span className="block font-mono text-xs text-[#64748B]">{r.itemCode}</span></td>
                <td className={cellClassName}>{r.distributorName} ({r.distributorCode})</td>
                <td className={`${cellClassName} text-right tabular-nums`}>{formatNumber(r.rowCount)}</td>
                <td className={cellClassName}>{r.earliestWeek || "—"}{r.latestWeek && r.latestWeek !== r.earliestWeek ? ` → ${r.latestWeek}` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AdminTableShell>
  );
}

export function MissingDataWorkspace({
  data,
  loadError,
  weekly,
  weeklyError,
}: {
  data: SalesReferenceGaps | null;
  loadError: string | null;
  weekly: WeeklyMissingProduct[];
  weeklyError: string | null;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [tab, setTab] = useState<"monthly" | "weekly">("monthly");
  const rescan = () => startTransition(() => router.refresh());

  const monthlyGapCodes = data ? data.groups.reduce((sum, group) => sum + group.gaps.length, 0) : 0;

  return (
    <div className="space-y-6">
      <AdminPageHero
        actions={
          <Button className="rounded" disabled={isPending} onClick={rescan} type="button" variant="secondary">
            <RefreshCw className={`mr-2 h-4 w-4 ${isPending ? "animate-spin" : ""}`} />
            {isPending ? "Rescanning…" : "Rescan"}
          </Button>
        }
        badges={
          <>
            {data ? <AdminInsightChip tone="slate">{formatNumber(data.scannedRows)} monthly rows scanned</AdminInsightChip> : null}
            {monthlyGapCodes ? <AdminInsightChip tone="orange">{monthlyGapCodes} monthly gaps</AdminInsightChip> : null}
            {weekly.length ? <AdminInsightChip tone="orange">{weekly.length} weekly gaps</AdminInsightChip> : null}
          </>
        }
        description="Reference codes used in uploaded sheets that don't yet exist in your masters/mappings. Fix the master or mapping and the held rows reconcile automatically — no re-upload needed."
        eyebrow="Sales · One connected module"
        icon={<TriangleAlert className="h-4 w-4" />}
        title="Missing Data"
      />

      <div className="flex gap-1.5">
        <TabButton active={tab === "monthly"} onClick={() => setTab("monthly")}>Monthly</TabButton>
        <TabButton active={tab === "weekly"} onClick={() => setTab("weekly")}>Weekly</TabButton>
      </div>

      {tab === "monthly" ? <MonthlyMissing data={data} loadError={loadError} /> : <WeeklyMissing loadError={weeklyError} rows={weekly} />}
    </div>
  );
}
