"use client";

import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { phxSelectClassName } from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";

/** Shared select recipe — dense, hairline border, orange focus ring (see [[premium-design-language]]). Native arrow
 * hidden via appearance-none; ChevronDown is layered on top for a consistent custom look across the module. */
export const selectFieldClassName =
  // `appearance-none` is NOT part of the shared select token — the token keeps the
  // browser's own arrow. This module layers its own ChevronDown on top, so it must
  // hide the native one or both arrows show.
  cn(phxSelectClassName, "appearance-none pr-8");

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
    // `group` so the chevron can darken with the control on hover — without it
    // the arrow stays flat grey while the border reacts, which reads as a
    // half-alive component. The label is the module's standard micro-caps.
    <label className="group flex flex-col text-[11px] font-black uppercase tracking-wide text-slate-500">
      <span className="overflow-hidden whitespace-nowrap">{label}</span>
      <div className="relative mt-1">
        <select
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          className={selectFieldClassName}
        >
          {children}
        </select>
        <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-slate-400 transition-colors group-hover:text-slate-600" />
      </div>
    </label>
  );
}
