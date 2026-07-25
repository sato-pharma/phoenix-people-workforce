"use client";

import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";

/** Shared select recipe — dense, hairline border, orange focus ring (see [[premium-design-language]]). Native arrow
 * hidden via appearance-none; ChevronDown is layered on top for a consistent custom look across the module. */
export const selectFieldClassName =
  "h-10 w-full cursor-pointer appearance-none border border-slate-300 bg-white px-3 pr-8 text-sm font-semibold text-slate-800 shadow-sm transition hover:border-slate-400 focus-visible:border-orange-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500/20";

/** A labeled <select> with a custom chevron, so every dropdown in Automated Payroll looks identical
 * regardless of the browser's native arrow style. */
export function SelectField({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col text-[11px] font-black uppercase tracking-wide text-slate-500">
      {label}
      <div className="relative mt-1">
        <select
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          className={selectFieldClassName}
        >
          {children}
        </select>
        <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-slate-400" />
      </div>
    </label>
  );
}
