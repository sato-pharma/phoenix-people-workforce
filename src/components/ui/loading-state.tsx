import { Loader2 } from "lucide-react";

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
