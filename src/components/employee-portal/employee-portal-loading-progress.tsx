"use client";

import { useEffect, useState } from "react";

export function EmployeePortalLoadingProgress() {
  const [progress, setProgress] = useState(12);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setProgress((current) => {
        if (current >= 96) return current;
        const step = current < 55 ? 7 : current < 82 ? 4 : 2;
        return Math.min(current + step, 96);
      });
    }, 180);

    return () => window.clearInterval(interval);
  }, []);

  return (
    <div className="employee-loading-card relative isolate overflow-hidden rounded border border-orange-100/80 bg-white p-8 text-center shadow-[0_16px_42px_rgba(15,23,42,0.08)]">
      <div className="employee-loading-glow pointer-events-none absolute -bottom-20 left-1/2 h-40 w-72 -translate-x-1/2 rounded-full bg-orange-500/20 blur-3xl" />
      <div className="relative mx-auto flex h-16 w-16 items-center justify-center rounded bg-slate-950 shadow-[0_16px_32px_rgba(15,23,42,0.18)]">
        <span className="employee-loading-flame" />
      </div>
      <p className="relative mt-5 text-sm font-semibold text-slate-900">Updating your portal</p>
      <p className="relative mt-1 text-xs font-medium text-slate-500">Preparing performance, payroll, and support data</p>
      <div className="relative mx-auto mt-6 max-w-md">
        <div className="mb-2 flex items-center justify-between text-xs font-bold text-slate-500">
          <span>Loading</span>
          <span className="tabular-nums text-orange-600">{progress}%</span>
        </div>
        <div className="h-2.5 overflow-hidden rounded-sm bg-slate-100 ring-1 ring-slate-200">
          <div
            className="employee-loading-bar h-full rounded-sm bg-[linear-gradient(90deg,#fb923c,#f97316,#ea580c)]"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
    </div>
  );
}
