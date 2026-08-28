"use client";

import { LucideIcon } from "lucide-react";
import { ReactNode } from "react";
import { cn } from "@/lib/utils";

type SectionHeaderProps = {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  action?: ReactNode;
  className?: string;
};

export function SectionHeader({ icon: Icon, title, subtitle, action, className }: SectionHeaderProps) {
  return (
    <div className={cn("flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4", className)}>
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-phx-accent/10 text-phx-accent">
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-black uppercase tracking-[0.12em] text-phx-ink">{title}</h2>
          {subtitle && <p className="mt-1 text-xs leading-5 text-phx-ink-soft">{subtitle}</p>}
        </div>
      </div>
      {action}
    </div>
  );
}
