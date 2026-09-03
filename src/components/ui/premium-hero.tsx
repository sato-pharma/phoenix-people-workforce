import type { ReactNode } from "react";

import {
  pageHeaderDescriptionClassName,
  pageHeaderKickerClassName,
  pageHeaderRailClassName,
  pageHeaderRuleClassName,
  pageHeaderTitleClassName,
} from "@/components/admin/admin-design-tokens";
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
  // POLISHED 2026-09-03 (second pass, same day): the accent rail and fading rule from
  // `admin-design-tokens`, so a module page's header is the same object as an admin page's
  // header. Both are zero-height additions — see the note on the tokens themselves.
  return (
    <section className="min-w-0">
      <div className="flex flex-col gap-3 pb-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <div className="relative min-w-0 space-y-1.5 pl-3.5">
          <span aria-hidden="true" className={pageHeaderRailClassName} />
          <p className={pageHeaderKickerClassName}>{kicker}</p>
          <h1 className={pageHeaderTitleClassName}>{title}</h1>
          {subtitle ? (
            <p className={cn(pageHeaderDescriptionClassName, subtitleClassName)}>{subtitle}</p>
          ) : null}
        </div>
        {badge ? <div className="min-w-0 shrink-0 sm:self-start">{badge}</div> : null}
      </div>
      <div aria-hidden="true" className={pageHeaderRuleClassName} />
    </section>
  );
}
