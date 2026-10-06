"use client";

import { SearchableSelect } from "@/components/ui/searchable-select";

/**
 * "Units for" — the one product whose units a weekly screen shows wherever its own figures would add
 * products together (owner, 2026-09-19). Units of different products are never added (owner rule,
 * 2026-08-27), so a screen holding several products shows its unit figures one product at a time, for
 * the product picked here; its values never move with the pick. The Upload screen carries the same bar
 * inline. `tone` matches the shell: the admin screens' paper, the portal screens' white cards, or `inset`
 * for a bar that sits inside a panel, under its own header.
 */
export function WeeklyUnitProductPicker({
  products,
  value,
  onChange,
  note,
  tone = "portal",
}: {
  products: readonly { code: string; name: string }[];
  value: string;
  onChange: (code: string) => void;
  note: string;
  tone?: "portal" | "admin" | "inset";
}) {
  const admin = tone === "admin";
  return (
    <div
      className={`flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 ${
        admin
          ? "border border-phx-line bg-phx-paper"
          : tone === "inset"
            ? "border-b border-slate-200 bg-white"
            : "border border-slate-200 bg-white shadow-[0_10px_30px_rgba(15,23,42,0.05)] ring-1 ring-slate-200/60"
      }`}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span
          className={`text-phx-xs font-black uppercase tracking-[0.14em] ${admin ? "text-phx-ink-soft" : "text-slate-500"}`}
        >
          Units for
        </span>
        <div className="w-72 max-w-full">
          <SearchableSelect
            aria-label="Product whose units are shown"
            className="h-8 px-2"
            onChange={(event) => onChange(event.target.value)}
            value={value}
            wrapValue
          >
            {products.map((product) => (
              <option key={product.code} value={product.code}>
                {product.name || product.code}
              </option>
            ))}
          </SearchableSelect>
        </div>
      </div>
      <p
        className={`min-w-0 flex-1 basis-64 break-words text-xs font-medium ${admin ? "text-phx-ink-soft" : "text-slate-500"}`}
      >
        {note}
      </p>
    </div>
  );
}
