"use client";

import type { ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";

import { Card } from "@/components/ui/card";
import { DarkSurfaceContext, useDarkSurface } from "@/components/ui/surface-context";
import { cn } from "@/lib/utils";
export {
  adminHeroAccentBarClassName,
  adminHeroActionPrimaryClassName,
  adminHeroActionSecondaryClassName,
  adminHeroChipClassName,
  adminHeroChipOrangeClassName,
  adminHeroDescriptionClassName,
  adminHeroGlowAmberClassName,
  adminHeroGlowOrangeClassName,
  adminHeroGridOverlayClassName,
  adminHeroKickerClassName,
  adminHeroSkeletonClassName,
  adminHeroSurfaceClassName,
  adminHeroTitleClassName,
  adminInsetPanelClassName,
  adminPanelClassName,
  adminShellBackgroundClassName,
  adminSoftPanelClassName,
} from "@/components/admin/admin-design-tokens";
import {
  pageHeaderDescriptionClassName,
  pageHeaderKickerClassName,
  pageHeaderRailClassName,
  pageHeaderRuleClassName,
  pageHeaderTitleClassName,
  adminHeroAccentBarClassName,
  adminHeroGlowAmberClassName,
  adminHeroGlowOrangeClassName,
  adminHeroGridOverlayClassName,
  adminHeroSurfaceClassName,
} from "@/components/admin/admin-design-tokens";

/**
 * Single source of truth for the black command-center hero surface. Renders the
 * gradient surface with its three decorative layers, and provides
 * `DarkSurfaceContext` so primitives (Button, AdminInsightChip) inside it pick
 * legible-on-black styling. Used by `AdminPageHero` and by both command centers,
 * which supply their own bespoke inner content as `children`.
 */
export function AdminHeroFrame({
  children,
  className,
}: {
  children: ReactNode;
  /** Extra surface classes (e.g. the CEO hero's ring/padding). */
  className?: string;
}) {
  return (
    <DarkSurfaceContext.Provider value={true}>
      <section className={cn(adminHeroSurfaceClassName, className)}>
        {/* The three decorative layers, restored 2026-09-08 with the premium-polish golden
            rule. Order matters: grid first so the glows sit ON it, then the accent edge,
            then the content. Every one is aria-hidden and pointer-events-none, so the hero
            reads identically to a screen reader and nothing here can swallow a click.
            `adminHeroSurfaceClassName` carries `overflow-hidden`, which is what keeps the
            two oversized glows from widening the page — without it they would push the
            document sideways and break the fits-the-screen golden rule. */}
        <div aria-hidden="true" className={adminHeroGridOverlayClassName} />
        <div aria-hidden="true" className={adminHeroGlowOrangeClassName} />
        <div aria-hidden="true" className={adminHeroGlowAmberClassName} />
        <div aria-hidden="true" className={adminHeroAccentBarClassName} />
        {/* Content sits above the decoration on its own stacking context, so a glow can
            never wash out a title or a button. */}
        <div className="relative">{children}</div>
      </section>
    </DarkSurfaceContext.Provider>
  );
}

export function AdminPageHero({
  actions,
  aside,
  badges,
  description,
  eyebrow,
  icon,
  title,
  compact = false,
  className,
}: {
  actions?: ReactNode;
  className?: string;
  /** Optional right-side slot for KPI tiles / profile (command centers). */
  aside?: ReactNode;
  badges?: ReactNode;
  compact?: boolean;
  description: string;
  eyebrow: string;
  icon?: ReactNode;
  title: string;
}) {
  // NO DARK BAND. Stripped 2026-09-03 at the owner's instruction — "remove from all pages this
  // dump block", after the same removal on the HR command center earlier the same day. This was
  // an `AdminHeroFrame`: a full-bleed black gradient with four decorative layers and
  // p-5 / sm:p-6 / lg:p-7, which spent most of the first fold restating the name of the page you
  // had just opened. It is now a plain title line on the page's own surface.
  //
  // THE PROP SHAPE IS DELIBERATELY UNCHANGED, and that is the point of doing it here rather than
  // at the call sites: 131 pages pass these props, and 37 of them pass `actions` that are real
  // controls — an export button, a "new request" button, a period picker. Deleting the block
  // outright would have taken those off the page with nothing at all to say so, which is the one
  // failure mode this change must not have.
  //
  // AND IT NO LONGER PROVIDES DarkSurfaceContext. That context is what told Button and
  // AdminInsightChip to style themselves legible-on-black. Kept over a white surface it paints
  // white text on white — so if a slot here ever renders blank, that is the first thing to check,
  // not the data behind it.
  //
  // `AdminHeroFrame` itself STAYS. It is still the frame for the two command centers and the
  // employee-360 / personal-workspace identity heroes, which supply their own inner content.
  //
  // POLISHED 2026-09-03, same day, second pass — the owner's words were "premium polish ... but
  // WITHOUT this thick banner block". The flattening above was correct and looked unfinished: a
  // bare title over a flat grey rule. What it gets here is an accent rail and a fading rule, both
  // from `admin-design-tokens`, and NEITHER ADDS A PIXEL OF HEIGHT — the rail sits inside the text
  // block's own left padding, the rule takes the same 1px the border-b took. The brief was polish
  // at zero vertical cost, and that is the test to apply to anything added here later.
  return (
    <section className={cn("min-w-0", className)}>
      <div
        className={cn(
          "flex flex-col gap-3 pb-4 lg:flex-row lg:items-start lg:justify-between lg:gap-6",
          compact && "gap-2 pb-3",
        )}
      >
        {/* pl-3.5 is the rail's gutter. The rail is absolute, so it costs nothing but this
            padding, and `relative` here is what anchors it. */}
        <div className="relative min-w-0 space-y-1.5 pl-3.5">
          <span aria-hidden="true" className={pageHeaderRailClassName} />
          <div className={pageHeaderKickerClassName}>
            {icon}
            {eyebrow}
          </div>
          <h1 className={pageHeaderTitleClassName}>{title}</h1>
          <p className={pageHeaderDescriptionClassName}>{description}</p>
          {badges ? (
            <div className="flex flex-wrap gap-2 pt-1 text-[12px] text-slate-600">{badges}</div>
          ) : null}
        </div>
        {actions || aside ? (
          <div className="flex min-w-0 flex-wrap items-center gap-2 lg:justify-end">
            {actions}
            {aside}
          </div>
        ) : null}
      </div>
      <div aria-hidden="true" className={pageHeaderRuleClassName} />
    </section>
  );
}

export function AdminInsightChip({
  children,
  tone = "neutral",
  surface,
}: {
  children: ReactNode;
  tone?: "neutral" | "orange" | "slate" | "emerald";
  /** Override auto-detection. Defaults to dark inside AdminPageHero, light elsewhere. */
  surface?: "light" | "dark";
}) {
  const heroDark = useDarkSurface();
  const dark = surface ? surface === "dark" : heroDark;

  const lightTone = {
    neutral: "border-slate-200/80 bg-slate-50 text-slate-600",
    orange: "border-orange-200/90 bg-orange-50 text-orange-700",
    slate: "border-slate-300/80 bg-slate-100 text-slate-700",
    emerald: "border-emerald-200/90 bg-emerald-50 text-emerald-700",
  }[tone];
  const darkTone = {
    neutral: "border-white/15 bg-white/10 text-slate-200",
    orange: "border-orange-400/40 bg-orange-500/15 text-orange-100",
    slate: "border-white/10 bg-white/[0.06] text-slate-300",
    emerald: "border-emerald-400/40 bg-emerald-500/15 text-emerald-200",
  }[tone];

  return (
    <div
      className={cn(
        "border px-4 py-2 text-xs font-bold uppercase tracking-[0.15em] transition-colors",
        dark ? cn(darkTone, "hover:border-white/30") : cn(lightTone, "hover:border-slate-300"),
      )}
    >
      {children}
    </div>
  );
}

export function AdminStatCard({
  description,
  icon,
  label,
  value,
  tone = "orange",
  variant = "default",
  size = "default",
}: {
  description: string;
  icon: ReactNode;
  label: string;
  value: ReactNode;
  tone?: "orange" | "blue" | "emerald" | "violet" | "rose";
  variant?: "default" | "full";
  size?: "default" | "compact";
}) {
  const toneClasses = {
    orange: {
      border: "hover:border-orange-300/80",
      bg: "bg-orange-200/15",
      icon: "border-orange-200 bg-orange-50 text-orange-600",
      card: "border-orange-300/70 bg-orange-50 text-orange-950",
      label: "text-orange-700/80",
      value: "text-orange-950",
      description: "text-orange-900/75",
      iconPlain: "text-orange-700",
    },
    blue: {
      border: "hover:border-blue-300/80",
      bg: "bg-blue-200/15",
      icon: "border-blue-200 bg-blue-50 text-blue-600",
      card: "border-blue-300/70 bg-blue-50 text-blue-950",
      label: "text-blue-700/80",
      value: "text-blue-950",
      description: "text-blue-900/75",
      iconPlain: "text-blue-700",
    },
    emerald: {
      border: "hover:border-emerald-300/80",
      bg: "bg-emerald-200/15",
      icon: "border-emerald-200 bg-emerald-50 text-emerald-600",
      card: "border-emerald-300/70 bg-emerald-50 text-emerald-950",
      label: "text-emerald-700/80",
      value: "text-emerald-950",
      description: "text-emerald-900/75",
      iconPlain: "text-emerald-700",
    },
    violet: {
      border: "hover:border-violet-300/80",
      bg: "bg-violet-200/15",
      icon: "border-violet-200 bg-violet-50 text-violet-600",
      card: "border-violet-300/70 bg-violet-50 text-violet-950",
      label: "text-violet-700/80",
      value: "text-violet-950",
      description: "text-violet-900/75",
      iconPlain: "text-violet-700",
    },
    rose: {
      border: "hover:border-rose-300/80",
      bg: "bg-rose-200/15",
      icon: "border-rose-200 bg-rose-50 text-rose-600",
      card: "border-rose-300/70 bg-rose-50 text-rose-950",
      label: "text-rose-700/80",
      value: "text-rose-950",
      description: "text-rose-900/75",
      iconPlain: "text-rose-700",
    },
  }[tone];

  const statDefaultSize = {
    containerClass: "space-y-3",
    iconContainerClass: "flex h-12 w-12 items-center justify-center border p-3",
    labelClass: "text-phx-2xs font-bold uppercase tracking-[0.15em]",
    valueClass: "text-3xl font-black tracking-tight",
    descriptionClass: "mt-4 text-sm leading-6",
  };

  const compactSize = {
    containerClass: "space-y-2",
    iconContainerClass: "flex h-9 w-9 items-center justify-center border p-2",
    labelClass: "text-phx-4xs font-black uppercase tracking-[0.12em]",
    valueClass: "text-xl font-black tracking-tight",
    descriptionClass: "mt-2 text-xs leading-4",
  };

  const sizeClasses = size === "compact" ? compactSize : statDefaultSize;

  if (variant === "full") {
    return (
      <Card className={cn("border p-6", toneClasses.card)}>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-3">
            <p className={cn("text-phx-2xs font-black uppercase tracking-[0.15em]", toneClasses.label)}>{label}</p>
            <div className={cn("text-3xl font-black tracking-tight", toneClasses.value)}>{value}</div>
          </div>
          <div className={cn("shrink-0", toneClasses.iconPlain)}>{icon}</div>
        </div>
        <p className={cn("mt-4 text-sm leading-6", toneClasses.description)}>{description}</p>
      </Card>
    );
  }

  const iconClassName = cn("shrink-0", sizeClasses.iconContainerClass, toneClasses.icon);

  return (
    <Card
      className={cn(
        "relative overflow-hidden border border-slate-200/90 bg-white transition-colors",
        toneClasses.border,
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className={cn("min-w-0", sizeClasses.containerClass)}>
          <p className={cn(sizeClasses.labelClass, "text-slate-400")}>{label}</p>
          <div className={cn(sizeClasses.valueClass, "text-slate-900")}>{value}</div>
        </div>
        <div className={iconClassName}>{icon}</div>
      </div>
      <p className={cn(sizeClasses.descriptionClass, "text-slate-500")}>{description}</p>
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
    danger: "border-rose-200/90 bg-rose-50 text-rose-800",
    neutral: "border-slate-200/90 bg-slate-50 text-slate-700",
    success: "border-emerald-200/90 bg-emerald-50 text-emerald-800",
    warning: "border-amber-200/90 bg-amber-50 text-amber-900",
  }[tone];

  return <div className={cn("flex items-start gap-3 border px-5 py-4 text-sm", toneClassName)}>{children}</div>;
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
  // ── The header row must WRAP, not crush its own title ─────────────────────────
  // Owner, 2026-09-12, with a screenshot of the Closing Matrix card: "fix the shit
  // we are seeing now" — the heading sat on top of the LINE label and the
  // description ran one word per line down the page.
  //
  // Two things combined, and neither is visible in a diff of the other:
  //   1. `app/globals.css` sets `min-width: 0` on every flex child in the admin
  //      shell that does not name a `min-w-*` of its own. That is deliberate (it
  //      is what keeps long cells from dragging a page sideways) and it means a
  //      text block here has NO min-content floor to stop at.
  //   2. The action carried `shrink-0`, so a wide toolbar took the whole row and
  //      the text block was shrunk to literally 0 px. Measured on production at
  //      819 px: action 752, text block 0 — heading 0 wide overflowing its box.
  //
  // So the row wraps instead. The text block gets a 20rem flex-basis, which is
  // small enough never to force a wrap on its own and large enough that when the
  // action does not fit beside it the action drops to its own line. Measured on
  // production, before → after: 640 px 0 → 558, 819 px 0 → 727, 960 px 100 → 868;
  // 1100 px and 1440 px are byte-identical, and 375 px never entered this branch.
  // `shrink-0` is gone because on its own line the action must be able to reflow —
  // it is also what made the toolbar's own `flex-wrap` inert.
  return (
    <div className="flex flex-col gap-4 border-b border-slate-200/80 bg-white px-5 py-5 sm:px-6 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between">
      <div className="sm:grow sm:shrink sm:basis-80">
        <div className="flex items-center gap-2.5">
          <span className="h-2 w-2 shrink-0 bg-phx-accent" />
          <h2 className="text-lg font-black tracking-tight text-slate-900">{title}</h2>
        </div>
        <p className="mt-2 text-sm leading-6 text-slate-500">{description}</p>
      </div>
      {action ? <div className="w-full sm:w-auto">{action}</div> : null}
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
    <Card className="overflow-hidden border border-slate-200/90 bg-white p-0">
      <AdminSectionHeader action={action} description={description} title={title} />
      {children}
    </Card>
  );
}

export function AdminLinkHint({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs font-semibold text-phx-accent-press">
      {children}
      <ArrowUpRight className="h-3.5 w-3.5" />
    </span>
  );
}
