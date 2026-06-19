"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";

// Tiny client island: switching the period navigates with ?period=… so the dashboard re-renders
// server-side (the rollup reads stay on the server, fast).
export function PeriodSelector({ periods, selected }: { periods: string[]; selected: string | null }) {
  const router = useRouter();
  const pathname = usePathname();
  if (periods.length === 0) return null;
  return (
    <label className="flex items-center gap-2 text-xs font-semibold text-[#475569]">
      Period
      <select
        className="h-9 border border-[#E2E8F0] bg-white px-2 text-sm text-[#0F172A]"
        value={selected ?? periods[0]}
        onChange={(e) => router.push(`${pathname}?period=${encodeURIComponent(e.target.value)}`)}
      >
        {periods.map((p) => (
          <option key={p} value={p}>{p}</option>
        ))}
      </select>
    </label>
  );
}
