/**
 * Shared visual primitives for outstation wizard / expense submission flows.
 *
 * Extracted from MobileOutstationWizard so the admin outstation pages can
 * reuse the same Step indicator, Field label, Stat cell, FieldValue, and
 * SummaryValue building blocks without duplication.
 *
 * No business logic lives here — these are presentational only.
 */

import type { ReactNode } from "react";

/* ------------------------------------------------------------------ */
/*  Step indicator                                                    */
/* ------------------------------------------------------------------ */

export function WizardStep({
  active,
  index,
  label,
}: {
  active: boolean;
  index: number;
  label: string;
}) {
  return (
    <div
      aria-current={active ? "step" : undefined}
      className={`flex items-center gap-2.5 px-3 py-2.5 ${
        active ? "border-l-2 border-orange-500 bg-orange-50/60" : "border-l-2 border-transparent"
      }`}
    >
      <span
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-phx-xs font-bold ${
          active ? "bg-orange-500 text-white" : "bg-slate-100 text-slate-500"
        }`}
      >
        {index}
      </span>
      <span
        className={`truncate text-phx-sm font-semibold ${
          active ? "text-slate-900" : "text-slate-500"
        }`}
      >
        {label}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Field label wrapper                                               */
/* ------------------------------------------------------------------ */

export function Field({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-phx-2xs font-semibold uppercase tracking-wider text-slate-500">
        {label}
      </span>
      {children}
    </label>
  );
}

/* ------------------------------------------------------------------ */
/*  Static stat cell (used in hero stat grid)                         */
/* ------------------------------------------------------------------ */

export function Stat({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="px-3 py-3">
      <p className="text-phx-2xs font-semibold uppercase tracking-wider text-slate-500">
        {label}
      </p>
      <p
        className="mt-1 truncate text-phx-md font-semibold text-slate-800"
        title={value}
      >
        {value}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Read-only field/value pair (used in calculation result grid)      */
/* ------------------------------------------------------------------ */

export function FieldValue({
  accent = "border-l-emerald-400",
  label,
  value,
}: {
  accent?: string;
  label: string;
  value: string;
}) {
  return (
    <div className={`border-l-2 ${accent} px-3 py-3`}>
      <p className="text-phx-2xs font-semibold uppercase tracking-wider text-slate-500">
        {label}
      </p>
      <p
        className="mt-1 truncate text-phx-md font-semibold capitalize text-slate-800"
        title={value}
      >
        {value}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Larger summary value (used in auto-calculated summary grid)       */
/* ------------------------------------------------------------------ */

export function SummaryValue({
  accent = "border-l-orange-400",
  label,
  value,
}: {
  accent?: string;
  label: string;
  value: string;
}) {
  return (
    <div className={`border-l-2 ${accent} px-3 py-3`}>
      <p className="text-phx-2xs font-semibold uppercase tracking-wider text-slate-500">
        {label}
      </p>
      <p
        className="mt-1 truncate text-phx-lg font-bold text-slate-900"
        title={value}
      >
        {value}
      </p>
    </div>
  );
}
