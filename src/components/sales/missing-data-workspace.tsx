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
import { useTransition } from "react";
import type { LucideIcon } from "lucide-react";

import { AdminCallout, AdminInsightChip, AdminPageHero, AdminTableShell } from "@/components/admin/admin-design-system";
import { CrmCard, CrmCardsOnPhone, CrmFacts } from "@/components/phoenix-crm/ui";
import { Button } from "@/components/ui/button";
import { formatNumber } from "@/lib/sales/format";
import type { ReferenceGapKind, SalesReferenceGaps } from "@/lib/sales/reference-gaps";

const KIND_ICON: Record<ReferenceGapKind, LucideIcon> = {
  product: Package,
  brick: Boxes,
  area: MapPin,
  region: MapIcon,
  distributor: Truck,
};

const tableHeaderClassName = "px-4 py-3 text-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft";
const cellClassName = "px-4 py-2.5 align-top text-phx-ink-2";

function joinCapped(values: string[], cap = 6): string {
  if (values.length === 0) return "—";
  if (values.length <= cap) return values.join(", ");
  return `${values.slice(0, cap).join(", ")} +${values.length - cap} more`;
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
            <div>
              <CrmCardsOnPhone>
                {group.gaps.map((gap) => (
                  <CrmCard
                    key={gap.code}
                    title={gap.code}
                  >
                    <CrmFacts
                      facts={[
                        { label: "Rows affected", value: formatNumber(gap.affectedRows) },
                        { label: "Distributors", value: joinCapped(gap.distributors) },
                        { label: "Periods", value: joinCapped(gap.periods) },
                      ]}
                    />
                  </CrmCard>
                ))}
              </CrmCardsOnPhone>
              <table className="hidden w-full table-fixed text-left text-sm md:table">
                <colgroup>
                  <col className="w-[22%]" />
                  <col className="w-[16%]" />
                  <col className="w-[34%]" />
                  <col className="w-[28%]" />
                </colgroup>
                <thead><tr>
                  <th className={tableHeaderClassName}><span className="inline-flex items-center gap-2"><Icon className="h-4 w-4 shrink-0" />Code</span></th>
                  <th className={`${tableHeaderClassName} text-right`}>Rows affected</th>
                  <th className={tableHeaderClassName}>Distributors</th>
                  <th className={tableHeaderClassName}>Periods</th>
                </tr></thead>
                <tbody className="divide-y divide-phx-line">
                  {group.gaps.map((gap) => (
                    <tr key={gap.code}>
                      <td className="break-words px-4 py-2.5 font-semibold text-phx-ink">{gap.code}</td>
                      <td className={`${cellClassName} text-right tabular-nums`}>{formatNumber(gap.affectedRows)}</td>
                      <td className={`${cellClassName} break-words`}>{joinCapped(gap.distributors)}</td>
                      <td className={`${cellClassName} break-words`}>{joinCapped(gap.periods)}</td>
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

export function MissingDataWorkspace({
  data,
  loadError,
}: {
  data: SalesReferenceGaps | null;
  loadError: string | null;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
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
          </>
        }
        description="Reference codes used in uploaded sheets that don't yet exist in your masters/mappings. Fix the master or mapping and the held rows reconcile automatically — no re-upload needed."
        eyebrow="Sales · One connected module"
        icon={<TriangleAlert className="h-4 w-4" />}
        title="Missing Data"
      />

      <MonthlyMissing data={data} loadError={loadError} />
    </div>
  );
}
