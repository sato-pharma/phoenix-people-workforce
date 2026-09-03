import { Loader2 } from "lucide-react";

import {
  pageHeaderDescriptionClassName,
  pageHeaderKickerClassName,
  pageHeaderRailClassName,
  pageHeaderRuleClassName,
  pageHeaderTitleClassName,
} from "@/components/admin/admin-design-tokens";
import { Card } from "@/components/ui/card";
import { systemIdentity } from "@/config/system-settings";
import { cn } from "@/lib/utils";

export function LoadingSpinner({ className }: { className?: string }) {
  return (
    <Loader2
      aria-hidden="true"
      className={cn("h-4 w-4 animate-spin text-primary", className)}
    />
  );
}

export function PageLoadingState({ title = "Loading" }: { title?: string }) {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <LoadingSpinner className="h-5 w-5" />
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.24em] text-primary">
            {systemIdentity.appName}
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-text">
            {title}
          </h1>
        </div>
      </div>

      <section className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((item) => (
          <Card className="space-y-5" key={item}>
            <div className="h-4 w-28 rounded bg-bg-muted" />
            <div className="h-8 w-20 rounded bg-bg-muted" />
            <div className="h-3 w-36 rounded bg-bg-muted" />
          </Card>
        ))}
      </section>

      <section className="grid gap-5 lg:grid-cols-12">
        <Card className="space-y-5 lg:col-span-7">
          <div className="h-5 w-40 rounded bg-bg-muted" />
          <div className="h-48 rounded-lg bg-bg-muted" />
        </Card>
        <Card className="space-y-5 lg:col-span-5">
          <div className="h-5 w-48 rounded bg-bg-muted" />
          {[0, 1, 2, 3].map((item) => (
            <div className="h-3 rounded bg-bg-muted" key={item} />
          ))}
        </Card>
      </section>
    </div>
  );
}

export function AppRouteLoadingState({
  title = "Loading workspace",
  description = "Preparing the next Phoenix Workforce view.",
}: {
  title?: string;
  description?: string;
}) {
  return (
    <div aria-live="polite" className="space-y-6" role="status">
      <span className="sr-only">{title}</span>
      {/* MATCHES THE FLATTENED HEADER, and had to move with it. This was the same dark
          `adminHeroSurfaceClassName` band the real pages carried until 2026-09-03, when the owner
          removed it everywhere — "remove from all pages this dump block". A skeleton that still
          painted a full black band would flash one for the whole load and then jump to a light
          title line, which reads as a layout bug rather than as a load. */}
      {/* THE SKELETON HAS TO CARRY THE POLISH TOO. It matched the flattened header exactly; when
          the rail and fading rule landed on `AdminPageHero` the skeleton stopped matching, and a
          skeleton one gesture short of what arrives is a visible jump at the end of every load.
          Same tokens, same geometry. */}
      <section className="min-w-0">
        <div className="flex flex-col gap-3 pb-4 lg:flex-row lg:items-end lg:justify-between lg:gap-6">
          <div className="relative min-w-0 space-y-1.5 pl-3.5">
            <span aria-hidden="true" className={pageHeaderRailClassName} />
            <p className={pageHeaderKickerClassName}>{systemIdentity.appName}</p>
            <h1 className={pageHeaderTitleClassName}>{title}</h1>
            <p className={pageHeaderDescriptionClassName}>{description}</p>
          </div>
          <LoadingSpinner className="h-6 w-6 shrink-0 text-orange-500" />
        </div>
        <div aria-hidden="true" className={pageHeaderRuleClassName} />
      </section>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((item) => (
          <Card className="space-y-4 p-4" key={item}>
            <div className="h-4 w-24 animate-pulse bg-bg-muted" />
            <div className="h-8 w-20 animate-pulse bg-bg-muted" />
            <div className="h-3 w-full animate-pulse bg-bg-muted" />
          </Card>
        ))}
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.35fr_0.65fr]">
        <Card className="space-y-4 p-5">
          <div className="h-5 w-44 animate-pulse bg-bg-muted" />
          <div className="h-[260px] animate-pulse bg-bg-muted" />
        </Card>
        <Card className="space-y-4 p-5">
          <div className="h-5 w-36 animate-pulse bg-bg-muted" />
          {[0, 1, 2, 3].map((item) => (
            <div className="flex items-center gap-3" key={item}>
              <div className="h-10 w-10 shrink-0 animate-pulse bg-bg-muted" />
              <div className="min-w-0 flex-1 space-y-2">
                <div className="h-3.5 w-3/4 animate-pulse bg-bg-muted" />
                <div className="h-3 w-1/2 animate-pulse bg-bg-muted" />
              </div>
            </div>
          ))}
        </Card>
      </section>
    </div>
  );
}
