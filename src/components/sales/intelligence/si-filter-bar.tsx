"use client";

import { Eye, EyeOff, Loader2 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

import type { SiAccessBadge } from "@/lib/sales/intelligence/types";
import { cn } from "@/lib/utils";

// Period selector + (CEO/Super-Admin-only) "Include Lacto Basic 1 & 2" toggle + scope badges.
// All navigation is server-driven (?period=, ?includeRestricted=1) so the server re-resolves the
// scope on every change — the toggle is UX, the server is the boundary.
export function SiFilterBar({
  access,
  availablePeriods,
  period,
}: {
  access: SiAccessBadge;
  availablePeriods: string[];
  period: string | null;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  function setParams(mutate: (params: URLSearchParams) => void) {
    const params = new URLSearchParams(searchParams.toString());
    mutate(params);
    startTransition(() => router.push(`?${params.toString()}`));
  }

  return (
    <div className="flex flex-col gap-3 border border-[#E2E8F0] bg-white p-3 md:flex-row md:items-center md:justify-between">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-black uppercase tracking-[0.16em] text-[#64748B]">Month</span>
        <select
          className="h-9 border border-[#D8E0EA] bg-[#F8FAFC] px-3 text-sm font-bold text-[#0F172A] outline-none focus:border-[#FDBA74]"
          disabled={pending || availablePeriods.length === 0}
          onChange={(event) => setParams((params) => params.set("period", event.target.value))}
          value={period ?? ""}
        >
          {availablePeriods.length === 0 ? (
            <option value="">No validated month</option>
          ) : (
            availablePeriods.map((value) => (
              <option key={value} value={value}>{value}</option>
            ))
          )}
        </select>
        {pending && <Loader2 className="h-4 w-4 animate-spin text-[#F97316]" />}

        {/* Scope badges — what this viewer is bounded to (geography by name). */}
        {!access.canViewAllSales && access.lineNames.length > 0 && (
          <span className="border border-[#E2E8F0] bg-[#F8FAFC] px-2.5 py-1 text-[11px] font-bold text-[#0F172A]">
            Line: {access.lineNames.join(", ")}
          </span>
        )}
        {!access.canViewAllSales && access.regionNames.length > 0 && (
          <span className="border border-[#E2E8F0] bg-[#F8FAFC] px-2.5 py-1 text-[11px] font-bold capitalize text-[#0F172A]">
            Region: {access.regionNames.join(", ")}
          </span>
        )}
      </div>

      {/* Restricted-products toggle — rendered ONLY for CEO / Super Admin. */}
      {access.includeRestrictedAllowed ? (
        <button
          className={cn(
            "inline-flex h-9 items-center gap-2 border px-3 text-xs font-black transition",
            access.restrictedIncluded
              ? "border-rose-300 bg-rose-50 text-rose-700 hover:bg-rose-100"
              : "border-[#D8E0EA] bg-white text-[#0F172A] hover:border-[#FDBA74] hover:text-[#F97316]",
          )}
          disabled={pending}
          onClick={() =>
            setParams((params) => {
              if (access.restrictedIncluded) params.delete("includeRestricted");
              else params.set("includeRestricted", "1");
            })
          }
          type="button"
        >
          {access.restrictedIncluded ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          {access.restrictedIncluded ? "Hide Lacto Basic 1 & 2" : "Include Lacto Basic 1 & 2"}
        </button>
      ) : (
        <span className="inline-flex h-9 items-center gap-2 border border-[#E2E8F0] bg-[#F8FAFC] px-3 text-[11px] font-bold text-[#64748B]">
          <EyeOff className="h-3.5 w-3.5" /> Restricted products excluded
        </span>
      )}
    </div>
  );
}
