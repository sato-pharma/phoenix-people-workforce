"use client";

import type { ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";

import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
export {
  adminInsetPanelClassName,
  adminPanelClassName,
  adminShellBackgroundClassName,
  adminSoftPanelClassName,
} from "@/components/admin/admin-design-tokens";
import {
  adminPanelClassName,
} from "@/components/admin/admin-design-tokens";

export function AdminPageHero({
  actions,
  badges,
  description,
  eyebrow,
  icon,
  title,
}: {
  actions?: ReactNode;
  badges?: ReactNode;
  description: string;
  eyebrow: string;
  icon?: ReactNode;
  title: string;
}) {
  return (
    <Card className={cn(adminPanelClassName, "p-0")}>
      <div className="flex flex-col gap-4 px-4 py-4 sm:px-5 lg:px-6">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0 space-y-3">
            <div className="inline-flex w-fit items-center gap-2 rounded-full border border-[#FED7AA] bg-[#FFF7ED] px-3 py-1 text-[10px] font-black uppercase tracking-[0.24em] text-[#C2410C]">
            {icon}
            {eyebrow}
            </div>
            <div className="space-y-2">
              <h1 className="max-w-4xl text-[1.45rem] font-black tracking-[-0.04em] text-[#0F172A] sm:text-[1.7rem] lg:text-[1.9rem]">
              {title}
              </h1>
              <p className="max-w-3xl text-sm leading-6 text-[#475569]">{description}</p>
            </div>
          </div>
          {actions ? (
            <div className="flex w-full flex-wrap items-stretch gap-2 sm:w-auto sm:items-center xl:max-w-[46%] xl:justify-end">{actions}</div>
          ) : null}
        </div>
        {badges ? <div className="flex flex-wrap gap-2 text-xs text-[#475569]">{badges}</div> : null}
      </div>
    </Card>
  );
}

export function AdminInsightChip({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "orange" | "slate";
}) {
  const toneClassName = {
    neutral: "border-slate-200/80 bg-gradient-to-r from-slate-50 to-slate-100 text-slate-600 shadow-sm",
    orange: "border-orange-200/90 bg-gradient-to-r from-orange-50/95 to-orange-100 text-orange-700 shadow-sm",
    slate: "border-slate-300/80 bg-gradient-to-r from-slate-100 to-slate-200 text-slate-700 shadow-sm",
  }[tone];

  return <div className={cn("rounded-full border px-4 py-2 text-xs font-bold uppercase tracking-[0.15em] transition-all duration-200 hover:shadow-md", toneClassName)}>{children}</div>;
}

export function AdminStatCard({
  description,
  icon,
  label,
  value,
  tone = "orange",
  variant = "default",
}: {
  description: string;
  icon: ReactNode;
  label: string;
  value: ReactNode;
  tone?: "orange" | "blue" | "emerald" | "violet" | "rose";
  variant?: "default" | "full";
}) {
  const toneClasses = {
    orange: {
      border: "hover:border-orange-300/80",
      bg: "bg-orange-200/15",
      icon: "from-orange-50 to-orange-100 text-orange-600 shadow-[0_8px_20px_rgba(249,115,22,0.15)] ring-orange-200",
      card: "border-orange-300/70 bg-gradient-to-br from-orange-100 via-orange-50 to-white text-orange-950 shadow-[0_18px_44px_rgba(249,115,22,0.16)]",
      label: "text-orange-700/80",
      value: "text-orange-950",
      description: "text-orange-900/75",
      iconPlain: "text-orange-700",
    },
    blue: {
      border: "hover:border-blue-300/80",
      bg: "bg-blue-200/15",
      icon: "from-blue-50 to-blue-100 text-blue-600 shadow-[0_8px_20px_rgba(59,130,246,0.15)] ring-blue-200",
      card: "border-blue-300/70 bg-gradient-to-br from-blue-100 via-sky-50 to-white text-blue-950 shadow-[0_18px_44px_rgba(59,130,246,0.16)]",
      label: "text-blue-700/80",
      value: "text-blue-950",
      description: "text-blue-900/75",
      iconPlain: "text-blue-700",
    },
    emerald: {
      border: "hover:border-emerald-300/80",
      bg: "bg-emerald-200/15",
      icon: "from-emerald-50 to-emerald-100 text-emerald-600 shadow-[0_8px_20px_rgba(16,185,129,0.15)] ring-emerald-200",
      card: "border-emerald-300/70 bg-gradient-to-br from-emerald-100 via-emerald-50 to-white text-emerald-950 shadow-[0_18px_44px_rgba(16,185,129,0.16)]",
      label: "text-emerald-700/80",
      value: "text-emerald-950",
      description: "text-emerald-900/75",
      iconPlain: "text-emerald-700",
    },
    violet: {
      border: "hover:border-violet-300/80",
      bg: "bg-violet-200/15",
      icon: "from-violet-50 to-violet-100 text-violet-600 shadow-[0_8px_20px_rgba(139,92,246,0.15)] ring-violet-200",
      card: "border-violet-300/70 bg-gradient-to-br from-violet-100 via-fuchsia-50 to-white text-violet-950 shadow-[0_18px_44px_rgba(139,92,246,0.16)]",
      label: "text-violet-700/80",
      value: "text-violet-950",
      description: "text-violet-900/75",
      iconPlain: "text-violet-700",
    },
    rose: {
      border: "hover:border-rose-300/80",
      bg: "bg-rose-200/15",
      icon: "from-rose-50 to-rose-100 text-rose-600 shadow-[0_8px_20_rgba(244,63,94,0.15)] ring-rose-200",
      card: "border-rose-300/70 bg-gradient-to-br from-rose-100 via-rose-50 to-white text-rose-950 shadow-[0_18px_44px_rgba(244,63,94,0.16)]",
      label: "text-rose-700/80",
      value: "text-rose-950",
      description: "text-rose-900/75",
      iconPlain: "text-rose-700",
    },
  }[tone];

  if (variant === "full") {
    return (
      <Card className={cn("rounded-[24px] border p-6 transition-all duration-300 ease-out hover:-translate-y-1 hover:scale-[1.01]", toneClasses.card)}>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-3">
            <p className={cn("text-[10px] font-black uppercase tracking-[0.15em]", toneClasses.label)}>{label}</p>
            <div className={cn("text-3xl font-black tracking-tight", toneClasses.value)}>{value}</div>
          </div>
          <div className={cn("shrink-0", toneClasses.iconPlain)}>{icon}</div>
        </div>
        <p className={cn("mt-4 text-sm leading-6", toneClasses.description)}>{description}</p>
      </Card>
    );
  }

  return (
    <Card className={cn("relative overflow-hidden rounded-[24px] border border-slate-200/90 bg-white/95 p-6 shadow-[0_16px_40px_rgba(15,23,42,0.06)] transition-all duration-300 ease-out hover:-translate-y-1 hover:bg-white hover:shadow-[0_24px_52px_rgba(15,23,42,0.14)] hover:scale-[1.02]", toneClasses.border)}>
      <div className={cn("pointer-events-none absolute -right-8 -top-10 h-32 w-32 rounded-full blur-3xl", toneClasses.bg)} />
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-3">
          <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-slate-400">{label}</p>
          <div className="text-3xl font-black tracking-tight text-slate-900">{value}</div>
        </div>
        <div className={cn("flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br p-3 ring-1 transition-all duration-300 hover:scale-110", toneClasses.icon)}>{icon}</div>
      </div>
      <p className="mt-4 text-sm leading-6 text-slate-500">{description}</p>
    </Card>
  );
}

export function AdminCallout({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "danger" | "neutral" | "success" | "warning";
}) {
  const toneClassName = {
    danger: "border-rose-200/90 bg-gradient-to-r from-rose-50/95 to-white text-rose-800 shadow-[0_8px_20px_rgba(244,63,94,0.12)]",
    neutral: "border-slate-200/90 bg-gradient-to-r from-slate-50/95 to-white text-slate-700 shadow-[0_8px_20px_rgba(15,23,42,0.08)]",
    success: "border-emerald-200/90 bg-gradient-to-r from-emerald-50/95 to-white text-emerald-800 shadow-[0_8px_20px_rgba(16,185,129,0.12)]",
    warning: "border-amber-200/90 bg-gradient-to-r from-amber-50/95 to-white text-amber-900 shadow-[0_8px_20px_rgba(245,158,11,0.12)]",
  }[tone];

  return <div className={cn("flex items-start gap-3 rounded-xl border px-5 py-4 text-sm transition-all duration-200 hover:shadow-md", toneClassName)}>{children}</div>;
}

export function AdminSectionHeader({
  action,
  description,
  title,
}: {
  action?: ReactNode;
  description: string;
  title: string;
}) {
  return (
    <div className="flex flex-col gap-4 border-b border-slate-200/80 bg-gradient-to-b from-white to-slate-50/50 px-5 py-5 sm:px-6 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <div className="flex items-center gap-2.5">
          <span className="h-2 w-2 rounded-full bg-gradient-to-r from-orange-500 to-amber-400 shadow-[0_0_8px_rgba(249,115,22,0.5)]" />
          <h2 className="text-lg font-black tracking-tight text-slate-900">{title}</h2>
        </div>
        <p className="mt-2 text-sm leading-6 text-slate-500">{description}</p>
      </div>
      {action ? <div className="w-full shrink-0 sm:w-auto">{action}</div> : null}
    </div>
  );
}

export function AdminTableShell({
  children,
  title,
  description,
  action,
}: {
  action?: ReactNode;
  children: ReactNode;
  description: string;
  title: string;
}) {
  return (
    <Card className="overflow-hidden rounded-2xl border border-slate-200/90 bg-white/95 shadow-[0_20px_48px_rgba(15,23,42,0.10)] p-0">
      <AdminSectionHeader action={action} description={description} title={title} />
      {children}
    </Card>
  );
}

export function AdminLinkHint({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs font-semibold text-[#C2410C]">
      {children}
      <ArrowUpRight className="h-3.5 w-3.5" />
    </span>
  );
}
