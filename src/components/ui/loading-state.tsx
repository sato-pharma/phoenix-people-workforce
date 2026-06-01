import { Loader2 } from "lucide-react";

import {
  adminHeroAccentBarClassName,
  adminHeroGlowAmberClassName,
  adminHeroGlowOrangeClassName,
  adminHeroGridOverlayClassName,
  adminHeroSurfaceClassName,
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
      <section className={adminHeroSurfaceClassName}>
        <div aria-hidden="true" className={adminHeroGridOverlayClassName} />
        <div aria-hidden="true" className={adminHeroGlowOrangeClassName} />
        <div aria-hidden="true" className={adminHeroGlowAmberClassName} />
        <div aria-hidden="true" className={adminHeroAccentBarClassName} />
        <div className="relative flex flex-col gap-4 p-5 sm:p-6 lg:p-7 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.22em] text-orange-200">
              {systemIdentity.appName}
            </p>
            <h1 className="mt-3 text-2xl font-black tracking-tight text-white">
              {title}
            </h1>
            <p className="mt-2 max-w-xl text-sm leading-6 text-slate-300">
              {description}
            </p>
          </div>
          <LoadingSpinner className="h-7 w-7 text-orange-500" />
        </div>
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
