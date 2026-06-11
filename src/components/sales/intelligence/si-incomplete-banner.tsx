"use client";

import { AlertTriangle, ArrowRight } from "lucide-react";
import Link from "next/link";

import { AdminCallout } from "@/components/admin/admin-design-system";
import type { SiMonthCompleteness, SiNewerPartial } from "@/lib/sales/intelligence/types";

function SwitchLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      className="inline-flex shrink-0 items-center gap-1 self-center border border-[#F97316] bg-[#FFF7ED] px-3 py-1.5 text-xs font-black text-[#EA580C] transition hover:bg-[#FFEDD5]"
      href={href}
    >
      {label} <ArrowRight className="h-3.5 w-3.5" />
    </Link>
  );
}

// One banner for both Sales Intelligence pages. Two honest states:
//  • showing a PARTIAL month        → explain it will rise as the rest upload + offer the last
//                                      complete month;
//  • showing a complete month while a NEWER partial month exists → offer to view that newer month.
// When the shown month is complete and nothing newer is partial, renders nothing.
export function SiIncompleteBanner({
  basePath,
  period,
  selectedCompleteness,
  newerPartial,
  latestCompletePeriod,
  includeRestricted,
}: {
  basePath: string;
  period: string | null;
  selectedCompleteness: SiMonthCompleteness | null;
  newerPartial: SiNewerPartial | null;
  latestCompletePeriod: string | null;
  includeRestricted: boolean;
}) {
  const hrefFor = (target: string) => {
    const params = new URLSearchParams();
    params.set("period", target);
    if (includeRestricted) params.set("includeRestricted", "1");
    return `${basePath}?${params.toString()}`;
  };

  if (selectedCompleteness && !selectedCompleteness.complete) {
    return (
      <AdminCallout tone="warning">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">
            {period} is a partial month — {selectedCompleteness.uploaded.length} of {selectedCompleteness.expected.length} distributors uploaded.
          </p>
          <p className="mt-1 text-sm">
            Still missing: {selectedCompleteness.missing.join(", ") || "—"}. Figures will rise as the remaining distributors upload.
          </p>
        </div>
        {latestCompletePeriod && latestCompletePeriod !== period ? (
          <SwitchLink href={hrefFor(latestCompletePeriod)} label={`Back to ${latestCompletePeriod}`} />
        ) : null}
      </AdminCallout>
    );
  }

  if (newerPartial) {
    return (
      <AdminCallout tone="neutral">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">
            Showing {period} (complete). {newerPartial.period} is still partial — {newerPartial.uploadedCount} of {newerPartial.expectedCount} distributors uploaded.
          </p>
          <p className="mt-1 text-sm">Missing for {newerPartial.period}: {newerPartial.missing.join(", ") || "—"}.</p>
        </div>
        <SwitchLink href={hrefFor(newerPartial.period)} label={`View ${newerPartial.period}`} />
      </AdminCallout>
    );
  }

  return null;
}
