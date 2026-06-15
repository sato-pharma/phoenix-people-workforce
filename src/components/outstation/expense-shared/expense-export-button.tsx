"use client";

import { Download } from "lucide-react";

export function ExpenseExportButton({
  href,
  disabled = false,
}: {
  href: string;
  disabled?: boolean;
}) {
  if (disabled) {
    return (
      <span className="inline-flex cursor-not-allowed items-center gap-2 rounded-full border border-white/15 bg-white/[0.06] px-4 py-2 text-xs font-bold uppercase tracking-[0.12em] text-white/30">
        <Download className="h-4 w-4" /> Export
      </span>
    );
  }
  return (
    <a
      href={href}
      className="inline-flex items-center gap-2 rounded-full bg-[#F97316] px-4 py-2 text-xs font-bold uppercase tracking-[0.12em] text-white shadow-[0_8px_20px_rgba(249,115,22,0.3)] transition-colors hover:bg-[#EA580C]"
    >
      <Download className="h-4 w-4" /> Export XLSX
    </a>
  );
}
