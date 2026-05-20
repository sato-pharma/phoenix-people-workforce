"use client";

import { AlertTriangle, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";

type RouteErrorStateProps = {
  description: string;
  error?: Error & { digest?: string };
  eyebrow: string;
  reset: () => void;
  title: string;
};

export function RouteErrorState({
  description,
  error,
  eyebrow,
  reset,
  title,
}: RouteErrorStateProps) {
  return (
    <div className="flex min-h-[420px] items-center justify-center rounded-[26px] border border-rose-200 bg-[linear-gradient(180deg,#fff7f7_0%,#ffffff_100%)] p-6 text-center shadow-[0_18px_46px_rgba(15,23,42,0.08)]">
      <div className="max-w-xl space-y-5">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-rose-100 bg-rose-50 text-rose-600 shadow-[0_12px_28px_rgba(244,63,94,0.14)]">
          <AlertTriangle className="h-7 w-7" />
        </div>
        <div className="space-y-2">
          <p className="text-[10px] font-black uppercase tracking-[0.22em] text-rose-600">{eyebrow}</p>
          <h2 className="text-2xl font-black tracking-tight text-slate-950">{title}</h2>
          <p className="text-sm leading-6 text-slate-600">{description}</p>
          {error?.digest ? (
            <p className="font-mono text-xs font-semibold text-slate-400">Error digest: {error.digest}</p>
          ) : null}
        </div>
        <Button className="gap-2" type="button" onClick={reset}>
          <RotateCcw className="h-4 w-4" />
          Try again
        </Button>
      </div>
    </div>
  );
}
