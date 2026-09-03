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
 * The header for a premium module page.
 *
 * NO DARK BAND. Flattened 2026-09-03 at the owner's instruction — "remove from all pages this
 * dump block" — the same removal made the same day to `AdminPageHero` (131 pages), the HR, CEO
 * and Finance command centers, My Workspace and the employee-360 review. This was a slate-900
 * banner at px-5 py-6 / sm:px-8 sm:py-7 with an orange kicker, a 1.9rem white title, a blurred
 * orange glow and an accent strip — six module pages spent that much of their first fold
 * restating the name of the page you had just opened.
 *
 * THE PROP SHAPE IS DELIBERATELY UNCHANGED, which is the point of doing it here rather than at
 * the six call sites: `badge` carries real status on several of them (a period, a run state) and
 * deleting the block outright would have taken those off the page with nothing to say so.
 *
 * `badge` no longer hides on mobile either. It was `hidden sm:block` because the dark band had
 * no room for it; a plain block does, and the owner's rule is that content wraps rather than
 * disappearing.
 */
export function PremiumHero({ kicker, title, subtitle, subtitleClassName, badge }: PremiumHeroProps) {
  return (
    <section className="flex flex-col gap-3 border-b border-phx-line pb-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div className="min-w-0 space-y-1.5">
        {/* Literal bracket sizes, not the named text-phx-* scale — cn() runs over the subtitle
            below and tailwind-merge silently drops custom NAMED font sizes. */}
        <p className="text-[11px] font-black uppercase tracking-[0.22em] text-orange-600">{kicker}</p>
        <h1 className="max-w-4xl text-[1.15rem] font-black leading-tight tracking-[-0.03em] text-slate-900 sm:text-[1.3rem]">
          {title}
        </h1>
        {subtitle ? (
          <p className={cn("max-w-3xl text-[13px] leading-5 text-slate-600", subtitleClassName)}>{subtitle}</p>
        ) : null}
      </div>
      {badge ? <div className="min-w-0 shrink-0 sm:self-start">{badge}</div> : null}
    </section>
  );
}
