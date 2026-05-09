"use client";

import { LucideIcon, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

type FilterChipProps = {
  label: string;
  icon?: LucideIcon;
  isActive?: boolean;
  onClick?: () => void;
  className?: string;
  showChevron?: boolean;
};

export function FilterChip({ 
  label, 
  icon: Icon, 
  isActive, 
  onClick, 
  className,
  showChevron = true 
}: FilterChipProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50",
        isActive && "border-orange-500 ring-1 ring-orange-500",
        className
      )}
    >
      {Icon && <Icon className="h-4 w-4 text-slate-400" />}
      {label}
      {showChevron && <ChevronDown className="h-4 w-4 text-slate-400" />}
    </button>
  );
}
