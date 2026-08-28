import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

type PremiumHeroProps = {
  /** Small orange uppercase label above the title. */
  kicker: string;
  /** Main heading (rendered as the page h1). */
  title: string;
  /** Optional supporting line under the title. */
  subtitle?: ReactNode;
  /** Optional extra classes for the subtitle (e.g. truncation). */
  subtitleClassName?: string;
  /** Optional right-aligned element (e.g. a status pill). Hidden on mobile. */
  badge?: ReactNode;
};

/**
 * The premium "command" hero from the Report It module, extracted for reuse:
 * a near-black slate-900 banner with an orange kicker, the title/subtitle,
 * a decorative orange glow, and a thin orange accent strip.
 * Square corners (matches the locked admin design language; the admin shell
 * also zeroes radii). Use it as the header for any premium module page.
 */
export function PremiumHero({ kicker, title, subtitle, subtitleClassName, badge }: PremiumHeroProps) {
  return (
    <section className="relative overflow-hidden border border-slate-800 bg-slate-900 px-5 py-6 shadow-sm sm:px-8 sm:py-7">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-orange-500/0 via-orange-400/80 to-orange-500/0"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -right-10 -top-12 h-48 w-48 rounded-full bg-orange-500/10 blur-2xl"
      />
      <div className="relative flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-phx-xs font-black uppercase tracking-[0.25em] text-orange-400">{kicker}</p>
          <h1 className="mt-1 text-2xl font-black leading-tight text-white sm:text-[1.9rem]">{title}</h1>
          {subtitle ? (
            <p className={cn("mt-2 max-w-2xl text-sm leading-6 text-slate-300", subtitleClassName)}>{subtitle}</p>
          ) : null}
        </div>
        {badge ? <div className="hidden shrink-0 self-start sm:block">{badge}</div> : null}
      </div>
    </section>
  );
}
